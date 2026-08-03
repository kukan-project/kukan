/**
 * Version diff (ADR-043 layer 2 / Phase ii-a).
 *
 * Resolves two of a resource's versions to their DuckLake snapshots and diffs
 * them. Every SQL statement that reaches DuckLake is composed here from version
 * numbers alone — user-supplied SQL never touches the lake (ADR-032's sandbox
 * is a separate path and stays unchanged).
 */
import { and, desc, eq, lt } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resourceVersion } from '@kukan/db'
import type { LakeConfig, LakeSession, VersionDiff } from '@kukan/lake'
import { diffVersions, lakeTableName, openLakeSession } from '@kukan/lake'
import { NotFoundError, RequestTimeoutError } from '@kukan/shared'
import { withDuckdbSlot } from './query/semaphore'
import { QUERY_MEMORY_LIMIT_MB, QUERY_THREADS, QUERY_TIMEOUT_MS } from '../config'

/** Why a diff could not be produced. Distinguished so the UI can explain it. */
export type DiffUnavailableReason =
  /** The version has no predecessor (it is the first). */
  | 'no-previous-version'
  /** One side isn't in DuckLake: not tabular, oversize, or created pre-Phase-ii. */
  | 'not-ingested'
  /** One side's content was purged, so it can no longer be compared. */
  | 'purged'

export type VersionDiffView =
  | { available: false; reason: DiffUnavailableReason; from: number | null; to: number }
  | ({ available: true; from: number; to: number } & VersionDiff)

const VERSION_COLUMNS = {
  version: resourceVersion.version,
  state: resourceVersion.state,
  snapshotId: resourceVersion.ducklakeSnapshotId,
}

interface VersionRow {
  version: number
  state: string
  snapshotId: number | null
}

export class VersionDiffService {
  constructor(
    private db: Database,
    private lake: LakeConfig
  ) {}

  private async getVersionRow(resourceId: string, version: number): Promise<VersionRow | null> {
    const [row] = await this.db
      .select(VERSION_COLUMNS)
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, version)))
      .limit(1)
    return row ?? null
  }

  /** The version immediately below `version`, purged ones included (they are
   *  reported as such rather than silently skipped). */
  private async getPreviousVersion(
    resourceId: string,
    version: number
  ): Promise<VersionRow | null> {
    const [row] = await this.db
      .select(VERSION_COLUMNS)
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), lt(resourceVersion.version, version)))
      .orderBy(desc(resourceVersion.version))
      .limit(1)
    return row ?? null
  }

  /**
   * Diff `toVersion` against `fromVersion` (default: the preceding version).
   * Throws NotFoundError when a requested version doesn't exist; an existing
   * version that simply can't be compared returns `available: false` with a
   * reason.
   */
  async diff(
    resourceId: string,
    toVersion: number,
    fromVersion?: number
  ): Promise<VersionDiffView> {
    const to = await this.getVersionRow(resourceId, toVersion)
    if (!to) throw new NotFoundError('Resource version', `${resourceId}/v${toVersion}`)

    let from: VersionRow | null
    if (fromVersion !== undefined) {
      from = await this.getVersionRow(resourceId, fromVersion)
      if (!from) throw new NotFoundError('Resource version', `${resourceId}/v${fromVersion}`)
    } else {
      from = await this.getPreviousVersion(resourceId, toVersion)
      if (!from) {
        return { available: false, reason: 'no-previous-version', from: null, to: to.version }
      }
    }

    const unavailable = (reason: DiffUnavailableReason): VersionDiffView => ({
      available: false,
      reason,
      from: from.version,
      to: to.version,
    })
    if (to.state === 'purged' || from.state === 'purged') return unavailable('purged')
    if (to.snapshotId === null || from.snapshotId === null) return unavailable('not-ingested')

    const diff = await this.runDiff(lakeTableName(resourceId), from.snapshotId, to.snapshotId)
    return { available: true, from: from.version, to: to.version, ...diff }
  }

  /**
   * Run the diff under the same bounds as an ADR-032 query: one shared
   * concurrency slot, a DuckDB memory/thread cap, and a wall-clock interrupt.
   * The comparison scans both snapshots in full, so without them a handful of
   * requests would take the container's memory with them.
   *
   * The slot is released in an outer `finally` that covers session setup too:
   * with a cap of one, a single failed ATTACH would otherwise wedge every
   * later diff *and* every ADR-032 query at 429 for the process's lifetime.
   */
  private async runDiff(
    table: string,
    fromSnapshot: number,
    toSnapshot: number
  ): Promise<VersionDiff> {
    return withDuckdbSlot(async () => {
      // The deadline covers session setup, not just the queries: extension load
      // and the catalog ATTACH are network work, and with a cap of one slot a
      // hung setup would hold every diff and every ADR-032 query at 429.
      let session: LakeSession | null = null
      let timedOut = false
      let expire!: (err: Error) => void
      const deadline = new Promise<never>((_, reject) => {
        expire = reject
      })
      const timer = setTimeout(() => {
        timedOut = true
        session?.interrupt()
        expire(new RequestTimeoutError(`Diff exceeded the time limit of ${QUERY_TIMEOUT_MS} ms`))
      }, QUERY_TIMEOUT_MS)

      // Held separately from `session` so a setup that lands after the deadline
      // is still closed rather than leaked.
      const opening = openLakeSession(this.lake, {
        memoryLimitMb: QUERY_MEMORY_LIMIT_MB,
        threads: QUERY_THREADS,
      }).then((s) => (session = s))

      try {
        await Promise.race([opening, deadline])
        return await Promise.race([
          diffVersions(session!, { table, fromSnapshot, toSnapshot }),
          deadline,
        ])
      } catch (err) {
        if (timedOut) {
          throw new RequestTimeoutError(`Diff exceeded the time limit of ${QUERY_TIMEOUT_MS} ms`)
        }
        throw err
      } finally {
        clearTimeout(timer)
        // Not awaited: a setup that hung past the deadline must not hold the
        // response or the shared slot. It is closed whenever it lands.
        void opening.then((s) => s.close()).catch(() => {})
      }
    })
  }
}
