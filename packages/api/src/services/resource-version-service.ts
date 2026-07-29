/**
 * KUKAN Resource Version Service
 * Read + purge-claim logic for immutable canonical file versions (ADR-043, layer 1).
 * Purge *execution* (file deletion, state → purged) runs in the worker via executePurge.
 */

import { randomUUID } from 'node:crypto'
import { digestStream } from '@kukan/shared/hash-node'
import { eq, and, lt, desc, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource, resourceVersion, resourcePipeline, auditLog } from '@kukan/db'
import { NotFoundError, getStorageKey, getVersionKey, versionOrigin } from '@kukan/shared'
import type { LakeConfig } from '@kukan/lake'
import {
  LAKE_PREVIEW_SUFFIX,
  dropLakeTable,
  lakeTableExists,
  lakeTableName,
  rollbackLakeTable,
  withLakeSession,
} from '@kukan/lake'
import type { ResourceSchema } from '@kukan/shared'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { QueueAdapter } from '@kukan/queue-adapter'
import { ingestVersionIntoLake, withLakeIngestLock } from './lake-ingest'
import { reclaimInSession } from './lake-reclaim'
import { withResourceClaims, withResourceClaimsOrConflict } from './pipeline-claim'
import { publishLiveContent } from './storage-pointer'
import { PipelineService } from './pipeline-service'

export type VersionState = 'active' | 'purging' | 'purged'
export type VersionOrigin = 'upload' | 'fetch'

/** What a purge needs to reach: layer 1, the search index, the queue, layer 2. */
interface PurgeDeps {
  storage: StorageAdapter
  search?: SearchAdapter
  queue: QueueAdapter
  lake?: LakeConfig
}

/**
 * Bounded concurrency for the one-time version backfill's storage copies.
 *
 * A migration is background work: it shares the worker's connection pool
 * (`WORKER_DB_POOL_MAX`, default 3) and its object store with the pipeline, the
 * crons and the health check, and none of them should wait on it. No longer a
 * pool reservation — since the capture lock went (ADR-044 §5) a unit holds a
 * connection only for each statement, not across its storage copy.
 */
const BACKFILL_CONCURRENCY = 2

/**
 * Current versions of tabular resources that are not in DuckLake yet (ADR-043
 * layer 2). Restricted to the latest active version because the preview Parquet
 * — the only tabular rendering that exists — always holds the newest content;
 * older versions cannot be reconstructed from it.
 *
 * The preview is mutable and outlives the run that made it — it is kept when an
 * Extract fails, and it still points at the old object while a re-queued
 * pipeline waits to start. Neither the version's hash nor a completed Extract
 * step rules that out: the backfill *creates* the version from the live file, so
 * their hashes always agree.
 *
 * What settles it is the hash of the bytes Extract actually parsed, recorded on
 * the pipeline alongside the preview it produced. Requiring it to equal the
 * version's hash means the Parquet provably describes *that* version.
 *
 * Previews written before that hash was recorded have none, and they are exactly
 * the ones this migration exists for — so they fall back to a weaker but still
 * sound test: the pipeline must be settled (`complete`, not re-queued behind a
 * newer file), that run's Extract must have produced the preview rather than
 * failing and leaving the previous one in place (a failed Extract does not fail
 * the pipeline), and the version must be the resource's live content. Steps are
 * cleared at the start of each run, so they describe only the latest one.
 *
 * Re-evaluated inside the ingest lock (see `ingestPendingIntoLake`), because the
 * scan and the ingest are minutes apart on a large migration.
 *
 * @param resourceId - restrict to one resource, for that re-check.
 */
function pendingLakeIngestQuery(resourceId?: string) {
  return sql`
  SELECT rv.resource_id AS "resourceId", rv.version, rp.preview_key AS "previewKey"
  FROM resource_version rv
  JOIN resource r ON r.id = rv.resource_id
  JOIN resource_pipeline rp ON rp.resource_id = r.id
  WHERE r.state = 'active'
    ${resourceId === undefined ? sql`` : sql`AND rv.resource_id = ${resourceId}::uuid`}
    AND rv.state = 'active'
    AND rv.ducklake_snapshot_id IS NULL
    AND rp.preview_key LIKE ${`%${LAKE_PREVIEW_SUFFIX}`}
    AND rv.hash IS NOT NULL
    AND (
      rp.metadata->>'sourceHash' = rv.hash
      OR (
        rp.metadata->>'sourceHash' IS NULL
        AND rp.status = 'complete'
        AND rv.hash = r.hash
        AND EXISTS (
          SELECT 1 FROM resource_pipeline_step s
          WHERE s.pipeline_id = rp.id AND s.step_name = 'extract' AND s.status = 'complete'
        )
      )
    )
    AND rv.version = (
      SELECT max(rv2.version) FROM resource_version rv2
      WHERE rv2.resource_id = rv.resource_id AND rv2.state = 'active'
    )
`
}

interface PendingLakeIngest {
  resourceId: string
  version: number
  previewKey: string
}

/** A version as exposed through the API. Purged versions are tombstones: their
 *  content-bearing fields (storageKey/hash/size/schema) are withheld. */
export interface VersionView {
  version: number
  origin: VersionOrigin
  state: VersionState
  size: number | null
  hash: string | null
  schema: ResourceSchema | null
  created: Date
  purgedAt: Date | null
  purgeReason: string | null
}

function toView(row: typeof resourceVersion.$inferSelect): VersionView {
  const purged = row.state === 'purged'
  return {
    version: row.version,
    origin: row.origin as VersionOrigin,
    state: row.state as VersionState,
    // Withhold content metadata for purged tombstones.
    size: purged ? null : row.size,
    hash: purged ? null : row.hash,
    schema: purged ? null : row.schema,
    created: row.created,
    purgedAt: row.purgedAt,
    purgeReason: row.purgeReason,
  }
}

export class ResourceVersionService {
  constructor(private db: Database) {}

  /**
   * Count active resources that have content but no version yet — the work left
   * for a one-time backfill (ADR-043). Zero means the migration is complete.
   */
  async countUnversioned(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(resource)
      .where(this.unversionedWhere())
    return row?.count ?? 0
  }

  /**
   * Active resources that have content but no version yet — the backfill work set.
   *
   * Resources whose pipeline is in flight are excluded: that run captures v1
   * itself, so counting them as outstanding migration work would misreport the
   * progress the dashboard shows. Whichever of the two arrives second at the
   * capture lock finds the version already there and steps aside.
   */
  private unversionedWhere() {
    return and(
      eq(resource.state, 'active'),
      sql`${resource.hash} IS NOT NULL`,
      sql`NOT EXISTS (SELECT 1 FROM ${resourceVersion} rv WHERE rv.resource_id = ${resource.id})`,
      sql`NOT EXISTS (
        SELECT 1 FROM ${resourcePipeline} rp
        WHERE rp.resource_id = ${resource.id} AND rp.status IN ('queued', 'processing')
      )`
    )
  }

  /**
   * Count latest versions that aren't in DuckLake yet — the layer-2 half of the
   * migration (ADR-043 Phase ii). Zero means every tabular resource's current
   * version can be diffed once it is updated again.
   */
  async countPendingLakeIngest(): Promise<number> {
    const result = await this.db.execute(sql`
      SELECT count(*)::int AS count FROM (${pendingLakeIngestQuery()}) t
    `)
    return (result.rows[0] as { count: number } | undefined)?.count ?? 0
  }

  /**
   * One-time migration: snapshot the live file of every unversioned resource as
   * v1 by server-side copy (ADR-043). No re-fetch, re-index, or re-embedding —
   * the current storage key already holds the content. Idempotent (skips
   * resources that already have a version). Runs in the worker.
   *
   * When a DuckLake config is supplied, a second pass loads each tabular
   * resource's current version into the lake (layer 2). The preview Parquet is
   * only ever the *latest* version's content, which is exactly what the current
   * version is — so this is the one moment existing data can enter the lake.
   * Older versions have no preview Parquet and stay out of it.
   */
  async backfillVersions(deps: { storage: StorageAdapter; lake?: LakeConfig }): Promise<{
    backfilled: number
    /** Captured or replaced by something else since the scan — retry-safe. */
    skipped: number
    failed: number
    ingested: number
    ingestFailed: number
  }> {
    // Fetch every unversioned resource once (small rows), then process each
    // exactly once — no re-query, so a failure isn't retried into a success.
    const rows = await this.db
      .select({
        id: resource.id,
        packageId: resource.packageId,
        urlType: resource.urlType,
        hash: resource.hash,
        size: resource.size,
        storageKey: resource.storageKey,
        schema: sql<ResourceSchema | null>`${resourcePipeline.metadata} -> 'schema'`,
        // Whether that schema was built from the bytes the resource holds now.
        // A failed Extract keeps the previous preview and schema without failing
        // the run, so an unchecked copy would pin an older content's columns
        // onto v1. Same test as `pendingLakeIngestQuery`, against the live hash.
        schemaTrusted: sql<boolean>`(
          ${resourcePipeline.metadata}->>'sourceHash' = ${resource.hash}
          OR (
            ${resourcePipeline.metadata}->>'sourceHash' IS NULL
            AND ${resourcePipeline.status} = 'complete'
            AND EXISTS (
              SELECT 1 FROM resource_pipeline_step s
              WHERE s.pipeline_id = ${resourcePipeline.id}
                AND s.step_name = 'extract' AND s.status = 'complete'
            )
          )
        )`,
      })
      .from(resource)
      .leftJoin(resourcePipeline, eq(resourcePipeline.resourceId, resource.id))
      .where(this.unversionedWhere())

    let backfilled = 0
    let skipped = 0
    let failed = 0
    // Per-resource copy+insert, bounded concurrency. Kept per-row (not one batched
    // INSERT) so one bad object fails only its own resource, not the whole chunk.
    for (let i = 0; i < rows.length; i += BACKFILL_CONCURRENCY) {
      const results = await Promise.allSettled(
        rows
          .slice(i, i + BACKFILL_CONCURRENCY)
          .map((r) => this.captureFirstVersion(r, deps.storage))
      )
      for (const res of results) {
        if (res.status === 'rejected') failed++
        else if (res.value) backfilled++
        // Skipped: something captured, replaced or is holding the resource.
        else skipped++
      }
    }

    const { ingested, ingestFailed } = await this.ingestPendingIntoLake(deps.lake)
    return { backfilled, skipped, failed, ingested, ingestFailed }
  }

  /**
   * Snapshot one resource's live file as v1, or report that nothing was done.
   *
   * Claimed for the duration (ADR-044): a run holding this resource is
   * capturing that same v1, and a migration is never worth waiting for — a
   * refused resource counts as skipped and the next run of the job picks it up.
   * Since the capture lock went (ADR-044 §5), the claim is the only thing
   * keeping the migration and a live run off the same resource.
   */
  private async captureFirstVersion(
    r: {
      id: string
      packageId: string
      urlType: string | null
      hash: string | null
      size: number | null
      storageKey: string | null
      schema: ResourceSchema | null
      schemaTrusted: boolean
    },
    storage: StorageAdapter
  ): Promise<boolean> {
    return this.withClaimOrSkip(r.id, async () => {
      // Re-checked against the row as it is *now*: the scan happened earlier,
      // and since then a pipeline run may have captured v1 (copying first would
      // overwrite its file before the unique index rejected the insert) or a
      // newer run may have moved the pointer, which means the object this row
      // described is no longer the content.
      const [current] = await this.db
        .select({
          storageKey: resource.storageKey,
          versions: sql<number>`(
            SELECT count(*)::int FROM ${resourceVersion} rv
            WHERE rv.resource_id = ${resource.id}
          )`,
        })
        .from(resource)
        .where(eq(resource.id, r.id))
        .limit(1)
      if (!current || current.versions > 0) return false
      if (!current.storageKey || current.storageKey !== r.storageKey) return false

      const versionKey = getVersionKey(r.packageId, r.id, 1)
      await storage.copy(current.storageKey, versionKey)
      // Measured rather than taken from the row: this is pre-existing data,
      // and `upload-complete` used to accept any string as a hash.
      const captured = await digestStream(await storage.download(versionKey))

      // Normalize the row to the measurement when the stored values were never
      // the real ones; refusing those rows instead would leave the migration
      // permanently incomplete. Guarded on the pointer, since a pipeline run
      // may have published newer content while this copied — its hash
      // describes that content and must not be overwritten with a measurement
      // of the object it replaced.
      if (captured.hash !== r.hash || captured.size !== r.size) {
        await this.db
          .update(resource)
          .set({ hash: captured.hash, size: captured.size })
          .where(and(eq(resource.id, r.id), eq(resource.storageKey, current.storageKey)))
      }

      await this.db.insert(resourceVersion).values({
        resourceId: r.id,
        version: 1,
        storageKey: versionKey,
        size: captured.size,
        hash: captured.hash,
        origin: versionOrigin(r.urlType),
        schema: r.schemaTrusted ? (r.schema ?? null) : null,
      })
      return true
    })
  }

  /**
   * Do a unit of migration work with the resource claimed, treating one held by
   * a run as work not done rather than as a failure — the job is re-runnable,
   * and a migration has no business waiting on a live pipeline.
   */
  private async withClaimOrSkip(resourceId: string, fn: () => Promise<boolean>): Promise<boolean> {
    const outcome = await withResourceClaims(this.db, [resourceId], fn)
    return outcome.status === 'ran' ? outcome.result : false
  }

  /**
   * Propagate a purge into DuckLake (ADR-043 §9, layer 2).
   *
   * `restore` is given only when the purged version was the live one, since that
   * is when the lake's current contents would otherwise still hold the purged
   * rows: a snapshot rolls the table back to the version we reverted to, null
   * drops it because no version survives. Purging a middle version leaves the
   * contents alone.
   *
   * Either way the snapshot has to be expired and its Parquet deleted, or the
   * rows remain readable straight from the catalog. That runs for every purge
   * of a version that reached the lake, which is why this is no longer called
   * only for the live version.
   *
   * Failures propagate: the version stays in `purging` and the worker retries,
   * rather than a legal deletion silently completing with data left in the lake.
   */
  private async purgeFromLake(
    resourceId: string,
    lake: LakeConfig | undefined,
    purgedSnapshot: number | null,
    restore?: { toSnapshot: number | null }
  ): Promise<void> {
    // Never ingested: the lake holds nothing of this version, so there is
    // neither anything to roll back nor anything to free. Opening a session
    // costs extension loads and a catalog ATTACH — not worth it to find that
    // out, and most resources are not tabular.
    if (!lake || purgedSnapshot === null) return
    const table = lakeTableName(resourceId)
    await withLakeSession(lake, async (session) => {
      await withLakeIngestLock(this.db, async () => {
        // Non-tabular resource, or never ingested — nothing to roll back, but
        // the reclaim below still runs: another resource's purge may have left
        // snapshots behind when it failed partway.
        if (restore && (await lakeTableExists(session, table))) {
          if (restore.toSnapshot === null) {
            await dropLakeTable(session, table)
          } else {
            await rollbackLakeTable(session, table, restore.toSnapshot)
          }
        }
      })
      // The row being purged is already out of `active`, so the reclaim reads
      // its snapshot as unreferenced without needing a special case.
      await reclaimInSession(this.db, session)
    })
  }

  /**
   * Load the current version of each tabular resource into DuckLake (layer 2).
   *
   * The migration's second pass, and the standing repair for every version that
   * did not reach the lake the first time. The intent to ingest is already in
   * the database — an active version with no `ducklake_snapshot_id` — so a run
   * whose Lake step failed *and* whose retry could not be enqueued is not lost
   * work, it is a row this pass will find. That is what makes an enqueue
   * failure survivable without an outbox of its own.
   *
   * Only the latest version of each resource is reachable this way: the preview
   * Parquet is the sole tabular rendering and it always holds the newest
   * content. A mid-history version whose own preview is still within the orphan
   * retention needs the queued retry job, which names that preview explicitly.
   *
   * One session for the whole pass (opening one is expensive), but the advisory
   * lock is taken per resource: it is what makes the committed snapshot
   * identifiable, and holding it for the entire pass would block the pipeline's
   * own ingests for the duration.
   *
   * Safe to run from every worker at once: each resource is taken under its
   * claim (ADR-044), so two sweeps cannot ingest the same one.
   */
  async ingestPendingIntoLake(
    lake: LakeConfig | undefined
  ): Promise<{ ingested: number; ingestFailed: number }> {
    if (!lake) return { ingested: 0, ingestFailed: 0 }

    const result = await this.db.execute(pendingLakeIngestQuery())
    const pending = result.rows as unknown as PendingLakeIngest[]
    if (pending.length === 0) return { ingested: 0, ingestFailed: 0 }

    let ingested = 0
    let ingestFailed = 0
    await withLakeSession(lake, async (session) => {
      for (const row of pending) {
        try {
          // Claimed like the capture pass above (ADR-044): the preview this
          // reads is the one a run in flight is replacing.
          const done = await this.withClaimOrSkip(row.resourceId, () =>
            withLakeIngestLock(this.db, async (tx) => {
              // Re-run the same predicate inside the lock. A pipeline run that
              // landed since the scan may have replaced the preview with a newer
              // version's content, which would otherwise be recorded as this
              // version's snapshot.
              const fresh = await tx.execute(pendingLakeIngestQuery(row.resourceId))
              const stillPending = (fresh.rows as unknown as PendingLakeIngest[]).some(
                (r) => r.version === row.version && r.previewKey === row.previewKey
              )
              if (!stillPending) return false
              return (await ingestVersionIntoLake(tx, session, lake, row)) !== null
            })
          )
          if (done) ingested++
        } catch {
          // One resource's failure must not abandon the rest of the migration.
          ingestFailed++
        }
      }
    })
    return { ingested, ingestFailed }
  }

  /** List a resource's versions, newest first. */
  async listByResource(resourceId: string): Promise<VersionView[]> {
    const rows = await this.db
      .select()
      .from(resourceVersion)
      .where(eq(resourceVersion.resourceId, resourceId))
      .orderBy(desc(resourceVersion.version))
    return rows.map(toView)
  }

  /** Get a single version (tombstone view when purged). */
  async getVersion(resourceId: string, version: number): Promise<VersionView> {
    const row = await this.getRow(resourceId, version)
    return toView(row)
  }

  /**
   * Resolve the storage key for downloading a version's content.
   * Throws NotFoundError when the version is missing or purged (content gone).
   */
  async getDownloadTarget(
    resourceId: string,
    version: number
  ): Promise<{ storageKey: string; size: number | null }> {
    const row = await this.getRow(resourceId, version)
    if (row.state === 'purged') {
      throw new NotFoundError('Resource version', `${resourceId}/v${version}`)
    }
    return { storageKey: row.storageKey, size: row.size }
  }

  /**
   * Claim a version for purge: active → purging, recording who/why durably on the
   * row (ADR-028 pattern). Idempotent — a version already purging/purged is
   * returned unchanged and should not be re-enqueued.
   * Returns { claimed } so the route knows whether to enqueue the worker job.
   */
  async claimPurge(
    resourceId: string,
    version: number,
    userId: string,
    reason: string
  ): Promise<{ claimed: boolean; view: VersionView }> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(resourceVersion)
        .where(
          and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, version))
        )
        .limit(1)
        .for('update')

      if (!row) throw new NotFoundError('Resource version', `${resourceId}/v${version}`)

      if (row.state !== 'active') {
        return { claimed: false, view: toView(row) }
      }

      const [updated] = await tx
        .update(resourceVersion)
        .set({
          state: 'purging',
          purgedBy: userId,
          purgeReason: reason,
          updated: sql`NOW()`,
        })
        .where(eq(resourceVersion.id, row.id))
        .returning()

      await tx.insert(auditLog).values({
        entityType: 'resource_version',
        entityId: row.resourceId,
        action: 'purge_request',
        userId,
        changes: { version, reason },
      })

      return { claimed: true, view: toView(updated) }
    })
  }

  /**
   * Execute a claimed purge (state must be 'purging'). Runs in the worker so it
   * retries on failure. Idempotent: a row not in 'purging' is a no-op.
   *
   * Deletes the version's stored copy. If it was the live version, rolls the
   * current key back to the previous active version (or empties the resource when
   * none remains), invalidates derivatives, and re-enqueues the pipeline to
   * regenerate preview/index from the restored content. Finally marks the row
   * 'purged' (tombstone) and writes the audit entry.
   */
  async executePurge(
    resourceId: string,
    version: number,
    deps: PurgeDeps
  ): Promise<{ purged: boolean; rolledBack: boolean }> {
    // Held for the whole purge (ADR-044). Extract writes its preview to storage
    // before the database learns of it, and version capture copies the file
    // before inserting the row; a run inside either window would write those
    // objects back *after* this purge had swept them, with no row left to make
    // them reachable and nothing to reclaim them. A legal deletion cannot end
    // with the content still in the bucket. A refusal leaves the version in
    // 'purging', so the redelivered job finishes it.
    return withResourceClaimsOrConflict(this.db, [resourceId], () =>
      this.purgeVersion(resourceId, version, deps)
    )
  }

  private async purgeVersion(
    resourceId: string,
    version: number,
    deps: PurgeDeps
  ): Promise<{ purged: boolean; rolledBack: boolean }> {
    const [row] = await this.db
      .select()
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, version)))
      .limit(1)

    if (!row || row.state !== 'purging') {
      return { purged: false, rolledBack: false }
    }

    // Live version = no active version sits above this one.
    const [above] = await this.db
      .select({ version: resourceVersion.version })
      .from(resourceVersion)
      .where(
        and(
          eq(resourceVersion.resourceId, resourceId),
          eq(resourceVersion.state, 'active'),
          sql`${resourceVersion.version} > ${version}`
        )
      )
      .limit(1)
    const isLive = !above

    // Remove the immutable versioned copy.
    await deps.storage.delete(row.storageKey)

    let rolledBack = false
    if (isLive) {
      const [pkgRow] = await this.db
        .select({ packageId: resource.packageId, storageKey: resource.storageKey })
        .from(resource)
        .where(eq(resource.id, resourceId))
        .limit(1)

      if (pkgRow) {
        // Previous active version to restore as the live content.
        const [prev] = await this.db
          .select()
          .from(resourceVersion)
          .where(
            and(
              eq(resourceVersion.resourceId, resourceId),
              eq(resourceVersion.state, 'active'),
              lt(resourceVersion.version, version)
            )
          )
          .orderBy(desc(resourceVersion.version))
          .limit(1)

        if (prev) {
          // Restored through the same mover as every other writer (ADR-043): a
          // key of this run's own, and the pointer moves only once the copy is
          // complete, so a failed copy leaves the resource on the object it had.
          const restoredKey = getStorageKey(pkgRow.packageId, resourceId, randomUUID())
          await deps.storage.copy(prev.storageKey, restoredKey)
          await publishLiveContent(this.db, resourceId, {
            key: restoredKey,
            previousKey: pkgRow.storageKey,
            hash: prev.hash!,
            size: prev.size!,
            previousHash: null,
          })
          rolledBack = true
          // Layer 2 must follow the rollback: otherwise the lake's current
          // contents would still be the purged rows (ADR-043 §9).
          await this.purgeFromLake(resourceId, deps.lake, row.ducklakeSnapshotId, {
            toSnapshot: prev.ducklakeSnapshotId,
          })
        } else {
          // Nothing to roll back to — the resource is left with no live content.
          await this.db
            .update(resource)
            .set({ storageKey: null, hash: null, size: null, lastModified: sql`NOW()` })
            .where(eq(resource.id, resourceId))
        }

        // The mover parked the object holding the purged content; delete it now
        // instead of waiting for the sweep. A purge is a legal deletion, so
        // cutting off a reader that already resolved that key is the point.
        // The parked row survives and the sweep's delete is then a no-op.
        if (pkgRow.storageKey) await deps.storage.delete(pkgRow.storageKey)
        // No version survives, so the lake table goes with it.
        if (!prev)
          await this.purgeFromLake(resourceId, deps.lake, row.ducklakeSnapshotId, {
            toSnapshot: null,
          })

        // Invalidate derivatives so the purged content stops being served
        // immediately, before the (async) pipeline regenerates them.
        await this.invalidatePreview(resourceId, deps.storage)
        if (deps.search) await deps.search.deleteContent(resourceId)

        // Regenerate preview/index from the restored content. The Version step's
        // change gate sees the restored hash as the latest active version and
        // skips, so no spurious version is captured.
        if (rolledBack) {
          await new PipelineService(this.db, deps.queue).enqueue(resourceId)
        }
      }
    } else {
      // A middle version: the live contents are already free of it, but its own
      // snapshot still holds the rows and must be reclaimed (ADR-043 §9).
      await this.purgeFromLake(resourceId, deps.lake, row.ducklakeSnapshotId)
    }

    await this.db
      .update(resourceVersion)
      .set({
        state: 'purged',
        purgedAt: sql`NOW()`,
        updated: sql`NOW()`,
        // Drop the layer-2 reference: the tombstone must not point at content.
        ducklakeSnapshotId: null,
      })
      .where(eq(resourceVersion.id, row.id))

    await this.db.insert(auditLog).values({
      entityType: 'resource_version',
      entityId: resourceId,
      action: 'purge',
      userId: row.purgedBy,
      changes: { version, reason: row.purgeReason, rolledBack },
    })

    return { purged: true, rolledBack }
  }

  /** Delete the resource's preview object and clear its pipeline previewKey. */
  private async invalidatePreview(resourceId: string, storage: StorageAdapter): Promise<void> {
    const [pipe] = await this.db
      .select({ id: resourcePipeline.id, previewKey: resourcePipeline.previewKey })
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, resourceId))
      .limit(1)
    if (!pipe?.previewKey) return
    await storage.delete(pipe.previewKey)
    await this.db
      .update(resourcePipeline)
      .set({ previewKey: null, updated: sql`NOW()` })
      .where(eq(resourcePipeline.id, pipe.id))
  }

  private async getRow(resourceId: string, version: number) {
    const [row] = await this.db
      .select()
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, version)))
      .limit(1)
    if (!row) throw new NotFoundError('Resource version', `${resourceId}/v${version}`)
    return row
  }
}
