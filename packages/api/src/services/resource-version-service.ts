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
import {
  ConflictError,
  LAKE_INGEST_JOB_TYPE,
  NotFoundError,
  getStorageKey,
  getVersionKey,
  MAX_PARQUET_SOURCE_SIZE,
  versionOrigin,
} from '@kukan/shared'
import type { LakeConfig } from '@kukan/lake'
import {
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
import { withLakeIngestLock } from './lake-ingest'
import { reclaimInSession } from './lake-reclaim'
import {
  stillHeld,
  withClaimFromRun,
  withResourceClaims,
  withResourceClaimsOrConflict,
  type ResourceClaim,
} from './pipeline-claim'
import { copyObject, parkObject, publishLiveContent } from './storage-pointer'
import { PipelineService } from './pipeline-service'

export type VersionState = 'active' | 'purging' | 'purged'
export type VersionOrigin = 'upload' | 'fetch'

/** The row a capture adds, minus everything the table fills in. */
export interface CapturedVersion {
  resourceId: string
  version: number
  storageKey: string
  size: number
  hash: string
  origin: VersionOrigin
  /**
   * Null from the pipeline, which settles the version from its bytes alone and
   * interprets it afterwards (ADR-046). The backfill is the one caller with a
   * schema in hand: it is building v1 out of content that was already
   * interpreted, and carries that interpretation across.
   */
  schema: ResourceSchema | null
}

/**
 * Record a captured version, but only while `claim` still holds the resource
 * (ADR-044 §4).
 *
 * The one write a capture makes that outlives its run. Everything else a run
 * produces is its own record, which the tracker already conditions on the
 * claim; this is a row the resource keeps, and a run that was stopped adding
 * one leaves the resource describing itself as half-done when it is not — the
 * step that would have reported the version is the same one the kill cut off.
 *
 * The row references the version's object once this lands, so the write-ahead
 * record goes with it (ADR-045 §4) — in this statement, like every other write
 * that comes to reference a key. Left to a second statement, a process that
 * died in between left a record for a key something already referenced; the
 * sweep repairs that, since it asks before deleting, but the repair is an hour
 * away and the rule reads better with no exceptions in it.
 *
 * @returns false when the claim is gone. The caller has been displaced and
 *   should stop rather than carry on producing derivatives of this content.
 */
export async function insertVersionIfHeld(
  db: Pick<Database, 'execute'>,
  claim: ResourceClaim | null,
  v: CapturedVersion
): Promise<boolean> {
  const result = await db.execute(sql`
    WITH inserted AS (
      INSERT INTO resource_version (resource_id, version, storage_key, size, hash, origin, schema)
      SELECT ${v.resourceId}::uuid, ${v.version}, ${v.storageKey}::text, ${v.size}::bigint,
             ${v.hash}::text, ${v.origin}, ${v.schema ? JSON.stringify(v.schema) : null}::jsonb
      WHERE ${stillHeld(claim)}
      RETURNING id, storage_key
    ),
    released AS (
      DELETE FROM orphaned_object o USING inserted WHERE o.key = inserted.storage_key
    )
    SELECT id FROM inserted
  `)
  return result.rows.length > 0
}

/**
 * Record the interpretation of a version that is already captured (ADR-046).
 *
 * The capture no longer carries one. A version is settled from its bytes, and
 * what those bytes mean is worked out after — so a version with no schema is a
 * normal state rather than a failure, and one that stays that way can always be
 * interpreted again, because its file never changes.
 *
 * Under the claim for the same reason the insert is: this is a row the resource
 * keeps, and a run that has been displaced must not write onto it.
 *
 * @returns false when the claim is gone, or the version is not there.
 */
export async function setVersionSchemaIfHeld(
  db: Pick<Database, 'execute'>,
  claim: ResourceClaim | null,
  v: { resourceId: string; version: number; schema: ResourceSchema }
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE resource_version
    SET schema = ${JSON.stringify(v.schema)}::jsonb, updated = NOW()
    WHERE resource_id = ${v.resourceId}::uuid
      AND version = ${v.version}
      AND ${stillHeld(claim)}
    RETURNING id
  `)
  return result.rows.length > 0
}

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
 * Versions that layer 2 has not loaded yet (ADR-043 layer 2, ADR-046).
 *
 * The rule, in one place. A version is outstanding when it is an active version
 * of an active resource with no snapshot — everything else here is about not
 * queueing work that can never succeed:
 *
 * - a format an interpretation makes no table from, and a file too large for
 *   one, or every PDF and oversized CSV would sit here and be re-enqueued every
 *   hour for good
 * - a version a newer one has already overtaken, which the ingest refuses under
 *   its own lock (ii-a replaces the table's contents wholesale)
 * - a version already interpreted to nothing — an empty CSV has no table to
 *   load and never will, and its schema says so (ADR-046). Absent, rather than
 *   empty, means nothing has interpreted it yet
 *
 * What it replaces is two disjoint branches over `lake_source_key` and the
 * resource's current preview, plus a proof that the preview described *that*
 * version: the preview was mutable and outlived the run that made it, so
 * pointing layer 2 at it meant establishing which content it held. Reading the
 * version file needs none of that.
 *
 * Re-evaluated by the ingest under its own lock, so a version loaded between a
 * scan and the attempt is refused there.
 *
 * @param only - narrow to one version, for the handler's own pre-check.
 */
function pendingLakeIngestQuery(only?: { resourceId: string; version: number }) {
  const forVersion =
    only === undefined
      ? sql``
      : sql`AND rv.resource_id = ${only.resourceId}::uuid AND rv.version = ${only.version}`
  return sql`
  SELECT rv.resource_id AS "resourceId", rv.version, rv.storage_key AS "storageKey", rv.size,
         r.format
  FROM resource_version rv
  JOIN resource r ON r.id = rv.resource_id
  WHERE r.state = 'active'
    ${forVersion}
    AND rv.state = 'active'
    AND rv.ducklake_snapshot_id IS NULL
    AND lower(r.format) IN ('csv', 'tsv')
    AND rv.size IS NOT NULL
    AND rv.size <= ${MAX_PARQUET_SOURCE_SIZE}
    AND (rv.schema IS NULL OR jsonb_array_length(rv.schema -> 'columns') > 0)
    AND NOT EXISTS (
      SELECT 1 FROM resource_version newer
      WHERE newer.resource_id = rv.resource_id
        AND newer.version > rv.version
        AND newer.ducklake_snapshot_id IS NOT NULL
    )
`
}

/**
 * The version file to interpret, or null when this version is not outstanding.
 *
 * The same predicate the sweep uses, narrowed to one version — not a second
 * opinion. Asked by the handler before it reads anything: every worker task
 * runs the hourly sweep, so the same version arrives several times over, and
 * all but one of those would otherwise download and interpret up to 50MB to
 * find out the work was already done.
 */
export async function pendingLakeVersionSource(
  db: Pick<Database, 'execute'>,
  row: { resourceId: string; version: number }
): Promise<{ storageKey: string; format: string } | null> {
  const result = await db.execute(pendingLakeIngestQuery(row))
  const [found] = result.rows as unknown as { storageKey: string; format: string }[]
  return found ?? null
}

interface PendingLakeIngest {
  resourceId: string
  version: number
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
  async backfillVersions(deps: { storage: StorageAdapter; queue: QueueAdapter }): Promise<{
    backfilled: number
    /** Captured or replaced by something else since the scan — retry-safe. */
    skipped: number
    failed: number
    /** Versions handed to the worker to interpret and load (ADR-046). */
    queued: number
    /** Versions the queue refused; the hourly pass finds them again. */
    queueFailed: number
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

    const { queued, failed: queueFailed } = await this.queuePendingLakeIngests(deps.queue)
    return { backfilled, skipped, failed, queued, queueFailed }
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
    return this.withClaimOrSkip(r.id, async (claim) => {
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

      const versionKey = getVersionKey(r.packageId, r.id, 1, randomUUID())
      await copyObject(this.db, storage, current.storageKey, versionKey)
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

      const inserted = await insertVersionIfHeld(this.db, claim, {
        resourceId: r.id,
        version: 1,
        storageKey: versionKey,
        size: captured.size,
        hash: captured.hash,
        origin: versionOrigin(r.urlType),
        schema: r.schemaTrusted ? (r.schema ?? null) : null,
      })
      if (!inserted) return false
      return true
    })
  }

  /**
   * Do a unit of migration work with the resource claimed, treating one held by
   * a run as work not done rather than as a failure — the job is re-runnable,
   * and a migration has no business waiting on a live pipeline.
   */
  private async withClaimOrSkip(
    resourceId: string,
    fn: (claim: ResourceClaim | null) => Promise<boolean>
  ): Promise<boolean> {
    // One resource in, so at most one claim out. None means the resource has no
    // pipeline row, which is not a refusal: nothing can run against it either,
    // and a resource that was never enqueued still needs its v1.
    const outcome = await withResourceClaims(this.db, [resourceId], (claims) =>
      fn(claims[0] ?? null)
    )
    return outcome.status === 'ran' ? outcome.result : false
  }

  /**
   * Propagate a purge into DuckLake (ADR-043 §5, layer 2).
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
   * Queue every version layer 2 has not loaded yet (ADR-043 layer 2, ADR-046).
   *
   * The migration's second pass, and the standing repair for every version that
   * did not reach the lake the first time. The intent to ingest is already in
   * the database — an active version with no `ducklake_snapshot_id` — so a run
   * whose Lake step failed *and* whose retry could not be enqueued is not lost
   * work, it is a row this pass will find. That is what makes an enqueue
   * failure survivable without an outbox of its own.
   *
   * Queues rather than ingests. Loading a version now means interpreting its
   * file (ADR-046), which is the worker's job — reaching for it here would pull
   * encoding detection, DuckDB and object storage into this package. What this
   * knows is which versions are outstanding; what to do about one belongs with
   * the code that already does it for the pipeline.
   *
   * Safe to run from every worker at once, which they do — the cron is per
   * process, not per deployment. Duplicate messages are the cost, and the
   * handler answers the same question again before it interprets anything.
   */
  async queuePendingLakeIngests(queue: QueueAdapter): Promise<{ queued: number; failed: number }> {
    const result = await this.db.execute(pendingLakeIngestQuery())
    const pending = result.rows as unknown as PendingLakeIngest[]

    // Batched-concurrent like `PipelineService.enqueueAll`: a sequential loop
    // would block the single-threaded worker for minutes on the migration pass,
    // which has a version per tabular resource in it. Settled per message, so
    // one refusal costs its own row rather than the rest of the pass.
    const BATCH_SIZE = 100
    let queued = 0
    let failed = 0
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const results = await Promise.allSettled(
        pending.slice(i, i + BATCH_SIZE).map((row) =>
          queue.enqueue(LAKE_INGEST_JOB_TYPE, {
            resourceId: row.resourceId,
            version: row.version,
          })
        )
      )
      for (const r of results) {
        if (r.status === 'fulfilled') queued++
        else failed++
      }
    }
    return { queued, failed }
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
        .select({
          packageId: resource.packageId,
          storageKey: resource.storageKey,
          // Read so the mover can tell a genuine content change from a re-fetch
          // of the same bytes, and move `lastModified` accordingly.
          hash: resource.hash,
        })
        .from(resource)
        .where(eq(resource.id, resourceId))
        .limit(1)

      if (pkgRow) {
        // Previous active version to restore as the live content.
        const prev = await this.restoreLiveFromVersions(resourceId, pkgRow, deps.storage, {
          below: version,
        })
        rolledBack = prev !== null

        if (prev) {
          // Layer 2 must follow the rollback: otherwise the lake's current
          // contents would still be the purged rows (ADR-043 §5).
          await this.purgeFromLake(resourceId, deps.lake, row.ducklakeSnapshotId, {
            toSnapshot: prev.ducklakeSnapshotId,
          })
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
        await this.discardDerivedArtifacts(resourceId, deps.storage)
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
      // snapshot still holds the rows and must be reclaimed (ADR-043 §5).
      await this.purgeFromLake(resourceId, deps.lake, row.ducklakeSnapshotId)
    }

    await this.db
      .update(resourceVersion)
      .set({
        state: 'purged',
        purgedAt: sql`NOW()`,
        updated: sql`NOW()`,
        // Drop the layer-2 references: the tombstone must not point at content,
        // and that is both the snapshot and any Parquet an ingest was deferred
        // from (ADR-043 §6-6).
        ducklakeSnapshotId: null,
        lakeSourceKey: null,
      })
      .where(eq(resourceVersion.id, row.id))
    // Nothing names it now, so it needs the way back the ledger is for.
    await parkObject(this.db, row.lakeSourceKey)

    await this.db.insert(auditLog).values({
      entityType: 'resource_version',
      entityId: resourceId,
      action: 'purge',
      userId: row.purgedBy,
      changes: { version, reason: row.purgeReason, rolledBack },
    })

    return { purged: true, rolledBack }
  }

  /**
   * Stop the run and put the content back (ADR-044 §4, the middle rung).
   *
   * For the case the claim cannot fix on its own: the wrong file was uploaded,
   * and stopping the run leaves it live. Killing first is what makes the rest
   * safe — from there nothing is writing derivatives from the content being
   * retracted.
   *
   * The retracted object is parked, not deleted: it is unwanted, not illegal,
   * and a reader that already resolved the key deserves to finish. Destroying
   * it is the rung above (purge), which also takes the version rows with it —
   * so a version already captured from the wrong content survives this and has
   * to be purged on its own. That is the ladder working as intended, not a gap.
   *
   * The stop and the claim are one statement. Released and then re-taken, the
   * resource is free for the moment in between, and a job already waiting on it
   * would start writing over the very content being retracted.
   *
   * @returns the version restored, `null` when nothing survived to restore
   *   (the resource is emptied), and `notFound` for a resource that is gone.
   */
  async revertLiveContent(
    resourceId: string,
    deps: { storage: StorageAdapter; search?: SearchAdapter; queue: QueueAdapter }
  ): Promise<{ cancelled: boolean; restored: number | null }> {
    const { cancelled, restored } = await withClaimFromRun(
      this.db,
      resourceId,
      'revert',
      async (_claim, cancelled) => {
        const [current] = await this.db
          .select({
            packageId: resource.packageId,
            storageKey: resource.storageKey,
            hash: resource.hash,
          })
          .from(resource)
          .where(eq(resource.id, resourceId))
          .limit(1)
        if (!current) throw new NotFoundError('Resource', resourceId)

        // A revert steps back through the history, so where it lands is
        // decided by where it is standing: the newest version below the one
        // holding the live content.
        const restored = await this.restoreLiveFromVersions(resourceId, current, deps.storage, {
          below: await this.liveVersion(resourceId, current.hash),
        })

        // The derivatives describe the content just retracted, so they go now
        // rather than when the pipeline gets round to replacing them.
        await this.discardDerivedArtifacts(resourceId, deps.storage)
        if (deps.search) await deps.search.deleteContent(resourceId)

        return { cancelled, restored }
      }
    )

    // Rebuild the derivatives from the restored content, once the claim is
    // back: enqueued inside it, the run that picks the job up finds the
    // resource held and puts itself back on the queue for another 30 seconds.
    // The Version step's change gate sees the restored hash as the latest
    // active version and skips, so no spurious version is captured. Nothing to
    // rebuild from when the resource was emptied.
    if (restored) await new PipelineService(this.db, deps.queue).enqueue(resourceId)

    return { cancelled, restored: restored?.version ?? null }
  }

  /**
   * The version holding what is live now, if any version holds it.
   *
   * Where a revert is standing, so that it can step back from there. Found by
   * hash because the live pointer names an object and not a version: whichever
   * row holds those bytes is the one being stepped off, wherever it sits in the
   * history. The newest of them, since content can repeat.
   *
   * Undefined when no version holds the live content — a file uploaded but
   * never captured, or a capture the kill cut off. There is nothing to step
   * back from, and the newest version is the right place to land.
   */
  private async liveVersion(resourceId: string, hash: string | null): Promise<number | undefined> {
    if (!hash) return undefined
    const [row] = await this.db
      .select({ version: resourceVersion.version })
      .from(resourceVersion)
      .where(
        and(
          eq(resourceVersion.resourceId, resourceId),
          eq(resourceVersion.state, 'active'),
          eq(resourceVersion.hash, hash)
        )
      )
      .orderBy(desc(resourceVersion.version))
      .limit(1)
    return row?.version
  }

  /**
   * Put the live pointer back on the newest surviving version's content, or
   * empty the resource when none survives.
   *
   * Shared by the two things that retract live content: a purge of the live
   * version (ADR-043 §5) and a revert (ADR-044 §4). They differ in what happens
   * to the object left behind — a purge destroys it, a revert lets the sweep
   * take it — not in how the pointer moves.
   *
   * Restored through the same mover as every other writer (ADR-043): a key of
   * this operation's own, and the pointer moves only once the copy is complete,
   * so a failed copy leaves the resource on the object it had.
   *
   * @param exclude.below - where to stop. Both callers name the version holding
   *   the content they are retracting — a purge the one it is destroying, a
   *   revert the one that is live — and everything above it is excluded with
   *   it. That is what stops a second revert stepping *forward* into a version
   *   an earlier one stepped off, and putting back what that one retracted.
   * @returns the version restored, or null when the resource was emptied.
   * @throws ConflictError when the pointer moved while this was running. Both
   *   callers go on to delete the preview and the indexed content, which
   *   describe whatever is live — so treating a lost move as a restore deletes
   *   the derivatives of the content that won. Uploads do not take the claim
   *   (ADR-044 §6), which is what leaves this reachable while one is held.
   */
  private async restoreLiveFromVersions(
    resourceId: string,
    current: { packageId: string; storageKey: string | null; hash?: string | null },
    storage: StorageAdapter,
    exclude: { below?: number } = {}
  ): Promise<typeof resourceVersion.$inferSelect | null> {
    const [prev] = await this.db
      .select()
      .from(resourceVersion)
      .where(
        and(
          eq(resourceVersion.resourceId, resourceId),
          eq(resourceVersion.state, 'active'),
          exclude.below === undefined ? sql`TRUE` : lt(resourceVersion.version, exclude.below)
        )
      )
      .orderBy(desc(resourceVersion.version))
      .limit(1)

    if (!prev) {
      // Through the mover like every other pointer move: unconditional, this
      // would clear a pointer an upload had moved since (uploads take no claim,
      // ADR-044 §6) and leave the retracted object tracked by nothing.
      const emptied = await publishLiveContent(this.db, resourceId, {
        key: null,
        previousKey: current.storageKey,
        hash: null,
        size: null,
        previousHash: current.hash ?? null,
      })
      if (!emptied) {
        throw new ConflictError(`Resource ${resourceId} changed while being emptied; retry`)
      }
      return null
    }

    const restoredKey = getStorageKey(current.packageId, resourceId, randomUUID())
    await copyObject(this.db, storage, prev.storageKey, restoredKey)
    const published = await publishLiveContent(this.db, resourceId, {
      key: restoredKey,
      previousKey: current.storageKey,
      hash: prev.hash!,
      size: prev.size!,
      previousHash: null,
    })
    // The mover parked this operation's own object on the way out, so nothing
    // is stranded by leaving.
    if (!published) {
      throw new ConflictError(`Resource ${resourceId} changed while being restored; retry`)
    }
    return prev
  }

  /**
   * Destroy what was derived from the content being retracted, and the pointers
   * that name it.
   *
   * Two artifacts, not one. The preview lives in a column; the text head
   * (ADR-040) lives in `metadata`, and being referenced there the sweep would
   * never take it either — so a purge that dropped only the preview left an
   * extract of the purged content in the bucket, still readable through the
   * suggestion path. A legal deletion cannot end with the content still
   * readable, which is the whole of ADR-043 §5.
   *
   * Deleted rather than parked, for both callers: a purge because destroying it
   * is the point, a revert because the artifacts describe the very file the
   * caller asked to stop serving.
   *
   * Each pointer is cleared only if it still names the key that was read, the
   * way every other pointer here moves: a run taken over for being stale could
   * have written a newer preview since, and clearing that would leave its object
   * with nothing naming it and nothing to reclaim it.
   */
  private async discardDerivedArtifacts(
    resourceId: string,
    storage: StorageAdapter
  ): Promise<void> {
    const [pipe] = await this.db
      .select({
        id: resourcePipeline.id,
        previewKey: resourcePipeline.previewKey,
        textHeadKey: sql<string | null>`${resourcePipeline.metadata} ->> 'textHeadKey'`,
      })
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, resourceId))
      .limit(1)

    const keys = [pipe?.previewKey, pipe?.textHeadKey].filter((k): k is string => !!k)
    if (keys.length === 0) return

    await storage.deleteMany(keys)
    await this.db.execute(sql`
      UPDATE resource_pipeline
      SET preview_key = CASE
            WHEN preview_key IS NOT DISTINCT FROM ${pipe!.previewKey}::text THEN NULL
            ELSE preview_key END,
          metadata = CASE
            WHEN metadata ->> 'textHeadKey' IS NOT DISTINCT FROM ${pipe!.textHeadKey}::text
            THEN metadata - 'textHeadKey'
            ELSE metadata END,
          updated = NOW()
      WHERE id = ${pipe!.id}::uuid
    `)
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
