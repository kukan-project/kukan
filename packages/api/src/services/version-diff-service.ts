/**
 * Version diff (ADR-043 layer 2 / Phase ii-a).
 *
 * Resolves two of a resource's versions to their DuckLake snapshots and diffs
 * them. Every SQL statement that reaches DuckLake is composed here from version
 * numbers alone — user-supplied SQL never touches the lake (ADR-032's sandbox
 * is a separate path and stays unchanged).
 */
import { and, desc, eq, lt } from 'drizzle-orm'
import type { Database, Transaction } from '@kukan/db'
import { resourceVersion } from '@kukan/db'
import type { LakeCatalogCache, LakeConfig, LakeObjectStore } from '@kukan/lake'
import { diffVersions, lakeTableName } from '@kukan/lake'
import type { JobQueue } from '@kukan/queue'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type {
  DiffUnavailableReason,
  LakeIngestReason,
  VersionDiff,
  VersionDiffView,
} from '@kukan/shared'
import {
  createBufferCache,
  KukanError,
  keyColumnsOf,
  NotFoundError,
  sharedKeyColumns,
} from '@kukan/shared'
import { currentLakeCatalog } from './lake/lake-catalog'
import { queueLakeRebuild } from './lake/lake-rebuild'
import { scanCatalog } from './query/lake-scan'

/**
 * Catalogs a diff has downloaded, by key (ADR-067 §3). A key is never written
 * twice, so nothing here goes stale; the bound is memory. One per process.
 */
const catalogCache: LakeCatalogCache = createBufferCache(32 * 1024 * 1024)

const VERSION_COLUMNS = {
  version: resourceVersion.version,
  state: resourceVersion.state,
  snapshotId: resourceVersion.lakeSnapshotId,
  keyColumns: resourceVersion.lakeKeyColumns,
  ingestReason: resourceVersion.lakeIngestReason,
}

interface VersionRow {
  version: number
  state: string
  snapshotId: number | null
  keyColumns: string[] | null
  ingestReason: LakeIngestReason | null
}

export class VersionDiffService {
  constructor(
    private db: Database,
    private lake: LakeConfig,
    private store: LakeObjectStore & Pick<StorageAdapter, 'head'>,
    /** To ask for a rebuild when the catalog is what failed (ADR-067 §6) */
    private queue: Pick<JobQueue, 'enqueue'>
  ) {}

  private async getVersionRow(
    db: Database | Transaction,
    resourceId: string,
    version: number
  ): Promise<VersionRow | null> {
    const [row] = await db
      .select(VERSION_COLUMNS)
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, version)))
      .limit(1)
    return row ?? null
  }

  /** The version immediately below `version`, purged ones included (they are
   *  reported as such rather than silently skipped). */
  private async getPreviousVersion(
    db: Database | Transaction,
    resourceId: string,
    version: number
  ): Promise<VersionRow | null> {
    const [row] = await db
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
    // The two ends and the catalog they are numbered in, read as one: a purge
    // rebuilds the catalog and renumbers the versions in one commit, and
    // pairing a number from before it with a catalog from after reads
    // another version's rows.
    const { to, from, catalogKey } = await this.db.transaction(
      async (tx) => {
        const to = await this.getVersionRow(tx, resourceId, toVersion)
        if (!to) throw new NotFoundError('Resource version', `${resourceId}/v${toVersion}`)
        let from: VersionRow | null
        if (fromVersion !== undefined) {
          from = await this.getVersionRow(tx, resourceId, fromVersion)
          if (!from) throw new NotFoundError('Resource version', `${resourceId}/v${fromVersion}`)
        } else {
          from = await this.getPreviousVersion(tx, resourceId, toVersion)
        }
        return { to, from, catalogKey: await currentLakeCatalog(tx, resourceId) }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' }
    )

    if (!from) {
      return {
        available: false,
        reason: 'no-previous-version',
        from: null,
        to: to.version,
        reasonVersion: null,
      }
    }

    const unavailable = (
      reason: DiffUnavailableReason,
      reasonVersion: number | null = null
    ): VersionDiffView => ({
      available: false,
      reason,
      from: from.version,
      to: to.version,
      reasonVersion,
    })
    // Before the reasons below, so a tombstone never explains itself with a
    // statement about the content it no longer holds (spec §9.4).
    // `purging` with it: claimed for purge, its rows stay in layer 2 until the
    // purge's rebuild commits, and what is being erased is not shown meanwhile
    const purged = (v: VersionRow) => v.state === 'purged' || v.state === 'purging'
    if (purged(to) || purged(from)) return unavailable('purged')
    if (to.snapshotId === null || from.snapshotId === null || catalogKey === null) {
      // A recorded refusal wherever it is, before the end that simply has no
      // snapshot: it is the only one of these an operator can act on. This end
      // before the other when both qualify — it is the one the reader opened.
      const blocked = [to, from].find((v) => v.ingestReason) ?? (to.snapshotId === null ? to : from)
      return unavailable(blocked.ingestReason ?? 'not-ingested', blocked.version)
    }

    let diff: VersionDiff
    try {
      diff = await this.runDiff(
        catalogKey,
        lakeTableName(resourceId),
        from.snapshotId,
        to.snapshotId,
        // **Only when both ends were loaded under the same key** (spec §7), through
        // the function the ingest asks the same question with.
        sharedKeyColumns(keyColumnsOf(from.keyColumns), keyColumnsOf(to.keyColumns)),
        signal
      )
    } catch (err) {
      // Stopped or turned away by this request's own bounds: nothing about the catalog
      if (err instanceof KukanError) throw err
      // Its object or a file it reads may be gone, which nothing else would
      // notice until the next ingest; the rebuild's handler looks
      await queueLakeRebuild(this.queue, resourceId)
      // Gone altogether, it is layer 2 not there yet rather than a fault, and
      // reads as such until the rebuild puts it back
      if ((await this.store.head(catalogKey)) === null) {
        return unavailable('not-ingested', to.version)
      }
      throw err
    }
    return { available: true, from: from.version, to: to.version, ...diff }
  }

  /**
   * Run the diff under the bounds every lake read from this container takes
   * (see {@link scanCatalog}). The comparison scans both snapshots in full, so
   * without them a handful of requests would take the container's memory with
   * them.
   */
  private async runDiff(
    catalogKey: string,
    table: string,
    fromSnapshot: number,
    toSnapshot: number,
    key: string[] | null,
    signal?: AbortSignal
  ): Promise<VersionDiff> {
    return scanCatalog(
      this.lake,
      this.store,
      { catalogKey, cache: catalogCache },
      'Diff',
      (session) => diffVersions(session, { table, fromSnapshot, toSnapshot, key }),
      signal
    )
  }
}
