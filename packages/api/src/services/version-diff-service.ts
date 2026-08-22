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
import type { LakeConfig, VersionDiff } from '@kukan/lake'
import { diffVersions, lakeTableName } from '@kukan/lake'
import { NotFoundError, sharedKeyColumns } from '@kukan/shared'
import { scanLake } from './query/lake-scan'

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
  keyColumns: resourceVersion.lakeKeyColumns,
}

interface VersionRow {
  version: number
  state: string
  snapshotId: number | null
  keyColumns: string[] | null
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
      // **Only when both ends were loaded under the same key** (spec §7), through
      // the function the ingest asks the same question with.
      sharedKeyColumns(from.keyColumns, to.keyColumns),
      signal
    )
    return { available: true, from: from.version, to: to.version, ...diff }
  }

  /**
   * Run the diff under the bounds every lake read from this container takes
   * (see {@link scanLake}). The comparison scans both snapshots in full, so
   * without them a handful of requests would take the container's memory with
   * them.
   */
  private async runDiff(
    table: string,
    fromSnapshot: number,
    toSnapshot: number,
    key: string[] | null,
    signal?: AbortSignal
  ): Promise<VersionDiff> {
    return scanLake(
      this.lake,
      'Diff',
      (session) => diffVersions(session, { table, fromSnapshot, toSnapshot, key }),
      signal
    )
  }
}
