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
import { NotFoundError, RequestAbandonedError, RequestTimeoutError } from '@kukan/shared'
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
   *
   * `signal` is the request's own: a diff whose caller hung up stops scanning
   * and gives up the shared DuckDB slot, rather than holding it for an answer
   * with no reader.
   */
  async diff(
    resourceId: string,
    toVersion: number,
    fromVersion?: number,
    signal?: AbortSignal
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

    const diff = await this.runDiff(
      lakeTableName(resourceId),
      from.snapshotId,
      to.snapshotId,
      signal
    )
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
    toSnapshot: number,
    signal?: AbortSignal
  ): Promise<VersionDiff> {
    return withDuckdbSlot(async () => {
      let session: LakeSession | null = null
      let scanning: Promise<VersionDiff> | null = null

      // Two reasons to stop, one mechanism: the run outlived its budget, or its
      // caller did not wait for it. The deadline covers session setup too — the
      // extension load and catalog ATTACH are network work, and with a cap of
      // one slot a hung setup would hold every later query behind it.
      const deadline = AbortSignal.timeout(QUERY_TIMEOUT_MS)
      const halt = signal ? AbortSignal.any([signal, deadline]) : deadline
      const timeout = () =>
        new RequestTimeoutError(`Diff exceeded the time limit of ${QUERY_TIMEOUT_MS} ms`)
      /** Why the scan was stopped, if it was: the interrupt makes the scan
       *  itself reject too, and that can win the race with `stopped`. */
      const haltReason = () =>
        deadline.aborted ? timeout() : signal?.aborted ? new RequestAbandonedError() : null

      let stop!: (err: Error) => void
      const stopped = new Promise<never>((_, reject) => {
        stop = reject
      })
      halt.addEventListener(
        'abort',
        () => {
          session?.interrupt()
          stop(haltReason()!)
        },
        { once: true }
      )

      // Held separately from `session` so a setup that lands after the deadline
      // is still closed rather than leaked.
      const opening = openLakeSession(this.lake, {
        memoryLimitMb: QUERY_MEMORY_LIMIT_MB,
        threads: QUERY_THREADS,
      }).then((s) => (session = s))

      try {
        await Promise.race([opening, stopped])
        scanning = diffVersions(session!, { table, fromSnapshot, toSnapshot })
        return await Promise.race([scanning, stopped])
      } catch (err) {
        throw haltReason() ?? err
      } finally {
        // Not awaited: a setup that hung past the deadline must not hold the
        // response or the shared slot. It is closed whenever it lands — after
        // the interrupted scan unwinds, because disconnecting in the same tick
        // as the interrupt leaves its promise pending forever (measured against
        // the driver). Interrupted alone it rejects at once, so this is free.
        void opening
          .then(async (s) => {
            await scanning?.catch(() => {})
            await s.close()
          })
          .catch(() => {})
      }
    }, signal)
  }
}
