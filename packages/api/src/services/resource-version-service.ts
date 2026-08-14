/**
 * KUKAN Resource Version Service
 * Read + purge-claim logic for immutable canonical file versions (ADR-043, layer 1).
 * Purge *execution* (file deletion, state → purged) runs in the worker via executePurge.
 */

import { digestStream } from '@kukan/shared/hash-node'
import { eq, and, desc, exists, inArray, sql } from 'drizzle-orm'
import type { Database, Transaction } from '@kukan/db'
import {
  resource,
  resourceVersion,
  resourcePipeline,
  resourcePipelineStep,
  auditLog,
} from '@kukan/db'
import {
  ConflictError,
  LAKE_INGEST_JOB_TYPE,
  NotFoundError,
  MAX_PARQUET_SOURCE_SIZE,
  versionOrigin,
} from '@kukan/shared'
import type { NoTableReason } from '@kukan/shared'
import type { LakeConfig } from '@kukan/lake'
import { dropLakeTable, lakeTableExists, lakeTableName, withLakeSession } from '@kukan/lake'
import type { Logger, ResourceSchema } from '@kukan/shared'
import { createLogger } from '@kukan/shared'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { QueueAdapter } from '@kukan/queue-adapter'
import { lakeStandsAhead, standLakeTableOn, withLakeIngestLock } from './lake-ingest'
import { reclaimInSession } from './lake-reclaim'
import {
  onRevision,
  stillHeld,
  withClaimFromRun,
  withResourceClaims,
  withResourceClaimsOrConflict,
  type ResourceClaim,
} from './pipeline-claim'
import { publishLiveContent, PARKED_UNTIL, ownedByVersion } from './storage-pointer'
import { PipelineService } from './pipeline-service'
import { markContentUnindexed } from './content-index-record'

export type VersionState = 'active' | 'purging' | 'purged' | 'superseded'
export type VersionOrigin = 'upload' | 'fetch'

/** The row creating a version adds, minus everything the table fills in. */
export interface CreatedVersion {
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
 * Record a created version, but only while `claim` still holds the resource
 * (ADR-044 §4).
 *
 * The one write creating a version makes that outlives its run. Everything else a run
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
 * The format is read off the resource here rather than passed in: it is the
 * condition this version's interpretation is made under (ADR-046), and a value
 * read before the insert can already be stale — nothing stops a metadata edit
 * while a run holds the claim.
 *
 * @returns false when the claim is gone. The caller has been displaced and
 *   should stop rather than carry on producing derivatives of this content.
 */
export async function insertVersionIfHeld(
  db: Pick<Database, 'execute'>,
  claim: ResourceClaim | null,
  v: CreatedVersion
): Promise<boolean> {
  const result = await db.execute(sql`
    WITH inserted AS (
      INSERT INTO resource_version (resource_id, version, storage_key, size, hash, origin, format, schema)
      SELECT ${v.resourceId}::uuid, ${v.version}, ${v.storageKey}::text, ${v.size}::bigint,
             ${v.hash}::text, ${v.origin}, r.format,
             ${v.schema ? JSON.stringify(v.schema) : null}::jsonb
      FROM resource r
      WHERE r.id = ${v.resourceId}::uuid AND ${stillHeld(claim)}
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
 * The resource as it stands right now, for the backfill to re-check before it
 * makes a v1 — whether anything has versioned it since the scan, and which
 * object it points at.
 *
 * Its own function so the emitted SQL can be pinned: the correlation is the
 * kind drizzle drops the qualifier from when it is written out by hand, and
 * this query is otherwise reachable only from inside a claimed,
 * storage-backed path.
 */
export function readBeforeFirstVersion(db: Database, resourceId: string) {
  return db
    .select({
      storageKey: resource.storageKey,
      versioned: exists(
        db.select({}).from(resourceVersion).where(eq(resourceVersion.resourceId, resource.id))
      ),
    })
    .from(resource)
    .where(eq(resource.id, resourceId))
    .limit(1)
}

/**
 * Whether some version already owns this object.
 *
 * A version owns the bytes it names: purging one deletes them, which is only
 * safe while nothing else is describing the same file (ADR-046 §3). Creating a
 * version therefore takes an object nothing owns, and copies one that is
 * already owned.
 *
 * That happens whenever live does not move between versions. An upload keeps
 * its key across runs, and a revert puts live back onto a version's own object
 * — so changing the interpretation of content that did not move would otherwise
 * file a second version against the first one's file.
 *
 * Tombstones do not own anything. A purged row keeps its key because the column
 * cannot be null, and the object it named is already gone.
 */
export async function objectAlreadyVersioned(
  db: Pick<Database, 'execute'>,
  key: string
): Promise<boolean> {
  const result = await db.execute(sql`SELECT ${ownedByVersion(sql`${key}::text`)} AS owned`)
  return (result.rows[0] as { owned: boolean } | undefined)?.owned === true
}

/**
 * Record the interpretation of a version that is already created (ADR-046).
 *
 * The create no longer carries one. A version is settled from its bytes, and
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
  v: {
    resourceId: string
    version: number
    schema: ResourceSchema
    noTableReason: NoTableReason | null
  }
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE resource_version
    SET schema = ${JSON.stringify(v.schema)}::jsonb,
        no_table_reason = ${v.noTableReason}::varchar,
        updated = NOW()
    WHERE resource_id = ${v.resourceId}::uuid
      AND version = ${v.version}
      AND ${stillHeld(claim)}
    RETURNING id
  `)
  return result.rows.length > 0
}

/**
 * What every rung of the ladder leaves behind (ADR-044 §4).
 *
 * Stopping, reverting and repairing all end the same way: some derivatives had
 * to go, and some work had to be queued to put them back. Answering in one
 * shape is what keeps the rule for reading it out of the client — otherwise it
 * has to remember which endpoint it called to know which field means done.
 *
 * The two halves never merge. Queueing a rebuild is not doing one, so `queued`
 * says a job is on its way and nothing more, while `cleared` says work actually
 * finished; folded together, a caller takes an enqueue for a repair.
 *
 * **Null is "nothing to do here", never a failure.** An emptied resource has
 * nothing to rebuild from, a resend has nothing left to clear — and both are
 * outcomes that stand. So one predicate covers the whole ladder:
 *
 * ```ts
 * const done = cleared !== false && queued !== false
 * ```
 */
export interface LadderOutcome {
  /** A job is on its way, or null when none was needed. */
  queued: boolean | null
  /** The derivatives are gone, or null when none needed to go. */
  cleared: boolean | null
}

/** What a purge needs to reach: layer 1, the search index, the queue, layer 2. */
interface PurgeDeps {
  storage: StorageAdapter
  search?: SearchAdapter
  queue: QueueAdapter
  lake?: LakeConfig
}

/**
 * Bounded concurrency for the one-time migration's units of work.
 *
 * A migration is background work: it shares the worker's connection pool
 * (`WORKER_DB_POOL_MAX`, default 3) and its object store with the pipeline, the
 * crons and the health check, and none of them should wait on it. No longer a
 * pool reservation — since the version lock went (ADR-044 §5) a unit holds a
 * connection only for each statement, not across the object it measures.
 */
const FIRST_VERSION_CONCURRENCY = 2

/**
 * Versions that layer 2 has not loaded yet (ADR-043 layer 2, ADR-046).
 *
 * The rule, in one place. A version is outstanding when it is an active version
 * of an active resource with no snapshot — everything else here is about not
 * queueing work that can never succeed:
 *
 * - a format an interpretation makes no table from, and a file too large for
 *   one, or every PDF and oversized CSV would sit here and be re-enqueued every
 *   hour for good. The version's format, not the resource's: relabelling a
 *   resource must not make bytes that were settled as a PDF eligible to be read
 *   as a table.
 *
 *   Both are re-read every pass rather than recorded on the row, and that is the
 *   point for the size: it is a cap, not a property of the bytes, so raising it
 *   makes what it excluded eligible again for free. Recorded as an empty schema
 *   instead, a version settled under the old cap would stay settled, and moving
 *   the cap would need an `UPDATE` nobody would think to run. The interpretation
 *   refuses over-cap versions too (ADR-046) — that is what makes both callers
 *   give one answer, not a second gate this one has to agree with
 * - a version an *active* newer one has already overtaken, which the ingest
 *   refuses under its own lock (ii-a replaces the table's contents wholesale).
 *   Only active ones overtake: a revert steps the versions above its
 *   destination off, and the destination is then exactly the version the table
 *   has to be loaded with. Counting those would leave a resource whose restored
 *   version never reached the lake standing on retracted rows forever, with
 *   nothing that ever queues it again
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
         rv.format
  FROM resource_version rv
  JOIN resource r ON r.id = rv.resource_id
  WHERE r.state = 'active'
    ${forVersion}
    AND rv.state = 'active'
    AND rv.ducklake_snapshot_id IS NULL
    AND lower(rv.format) IN ('csv', 'tsv')
    AND rv.size IS NOT NULL
    AND rv.size <= ${MAX_PARQUET_SOURCE_SIZE}
    AND (rv.schema IS NULL OR jsonb_array_length(rv.schema -> 'columns') > 0)
    AND NOT EXISTS (
      SELECT 1 FROM resource_version newer
      WHERE newer.resource_id = rv.resource_id
        AND newer.version > rv.version
        AND newer.state = 'active'
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
): Promise<{ storageKey: string; format: string; size: number } | null> {
  const result = await db.execute(pendingLakeIngestQuery(row))
  const [found] = result.rows as unknown as {
    storageKey: string
    format: string
    size: number
  }[]
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
  /** What this version was read as (ADR-046 §6). Kept on a tombstone: it
   *  describes how the content was interpreted, not the content itself. */
  format: string | null
  size: number | null
  hash: string | null
  schema: ResourceSchema | null
  /**
   * Why there is no table, when there is none.
   *
   * Beside the empty schema it explains: the schema says "interpreted, nothing
   * to load" and stops there, and that is not what someone asking why there is
   * no preview wants to know (ADR-046).
   *
   * `too-large` is derived here rather than read from the row. It is a fact
   * about the cap, not about the version — persist it and a version settled
   * under an old cap keeps saying so after the cap moves. The two the row does
   * carry are facts about the bytes, and the bytes never change.
   */
  noTableReason: NoTableReason | null
  created: Date
  purgedAt: Date | null
  purgeReason: string | null
}

/**
 * Why this version has no table — read off the row, or worked out from the cap.
 *
 * Nothing interprets an over-cap version, so the row has nothing to say about
 * it; the size and the cap do, and they answer freshly, which is what lets a
 * raised cap change the answer without touching a single row.
 */
function noTableReason(row: typeof resourceVersion.$inferSelect): NoTableReason | null {
  if (row.noTableReason) return row.noTableReason
  const oversized = row.size !== null && row.size > MAX_PARQUET_SOURCE_SIZE
  return oversized && row.schema === null ? 'too-large' : null
}

function toView(row: typeof resourceVersion.$inferSelect): VersionView {
  const purged = row.state === 'purged'
  return {
    version: row.version,
    origin: row.origin as VersionOrigin,
    state: row.state as VersionState,
    format: row.format,
    // Withhold content metadata for purged tombstones.
    size: purged ? null : row.size,
    hash: purged ? null : row.hash,
    schema: purged ? null : row.schema,
    noTableReason: purged ? null : noTableReason(row),
    created: row.created,
    purgedAt: row.purgedAt,
    purgeReason: row.purgeReason,
  }
}

/**
 * The one-purge-per-resource index refusing a second claim.
 *
 * Read through `cause` as well: the driver's error is what carries the code, and
 * the query builder wraps it.
 */
function isOnePurgingViolation(err: unknown): boolean {
  for (let e = err; e; e = (e as { cause?: unknown }).cause) {
    const { code, constraint } = e as { code?: string; constraint?: string }
    if (code === '23505' && (constraint ?? '').includes('one_purging')) return true
  }
  return false
}

export class ResourceVersionService {
  constructor(private db: Database) {}

  /**
   * Count active resources that have content but no version yet — the work left
   * for a one-time backfill (ADR-043). Zero means the migration is complete.
   */
  async countUnversioned(): Promise<number> {
    return this.db.$count(resource, this.unversionedWhere())
  }

  /**
   * Active resources that have content but no version yet — the migration work set.
   *
   * Resources whose pipeline is in flight are excluded: that run creates v1
   * itself, so counting them as outstanding migration work would misreport the
   * progress the dashboard shows. Whichever of the two arrives second at the
   * version lock finds the version already there and steps aside.
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
   * One-time migration: give every unversioned resource a v1 naming the file it
   * already holds (ADR-043 §1). Nothing is copied, fetched, re-indexed or
   * re-embedded — the live key is the content, and no other version owns it.
   * Idempotent (skips resources that already have a version). Runs in the
   * worker.
   *
   * Layer 2 is not loaded here. Each v1 is queued for the worker to interpret
   * and ingest (ADR-046), which is the same path a pipeline run takes — so the
   * lake never receives anything this process derived on the side.
   */
  async createFirstVersions(deps: { storage: StorageAdapter; queue: QueueAdapter }): Promise<{
    created: number
    /** Created or replaced by something else since the scan — retry-safe. */
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
        // A failed interpretation keeps the previous preview and schema without
        // failing the run, so an unchecked copy would pin an older content's
        // columns onto v1. The version's own bytes are what settle it.
        //
        // `'extract'` deliberately: this reads rows already written, and the
        // fallback only applies to previews from before the source hash existed
        // — all of which predate the rename (ADR-046). Matching `'interpret'`
        // here would find none of them.
        schemaTrusted: sql<boolean>`(
          ${resourcePipeline.metadata}->>'sourceHash' = ${resource.hash}
          OR (
            ${resourcePipeline.metadata}->>'sourceHash' IS NULL
            AND ${resourcePipeline.status} = 'complete'
            AND ${exists(
              this.db
                .select({})
                .from(resourcePipelineStep)
                .where(
                  and(
                    eq(resourcePipelineStep.pipelineId, resourcePipeline.id),
                    eq(resourcePipelineStep.stepName, 'extract'),
                    eq(resourcePipelineStep.status, 'complete')
                  )
                )
            )}
          )
        )`,
      })
      .from(resource)
      .leftJoin(resourcePipeline, eq(resourcePipeline.resourceId, resource.id))
      .where(this.unversionedWhere())

    let created = 0
    let skipped = 0
    let failed = 0
    // Per-resource measure+insert, bounded concurrency. Kept per-row (not one
    // batched INSERT) so one bad object fails only its own resource, not the
    // whole chunk.
    for (let i = 0; i < rows.length; i += FIRST_VERSION_CONCURRENCY) {
      const results = await Promise.allSettled(
        rows
          .slice(i, i + FIRST_VERSION_CONCURRENCY)
          .map((r) => this.createFirstVersion(r, deps.storage))
      )
      for (const res of results) {
        if (res.status === 'rejected') failed++
        else if (res.value) created++
        // Skipped: something created, replaced or is holding the resource.
        else skipped++
      }
    }

    const { queued, failed: queueFailed } = await this.queuePendingLakeIngests(deps.queue)
    return { created, skipped, failed, queued, queueFailed }
  }

  /**
   * Snapshot one resource's live file as v1, or report that nothing was done.
   *
   * Claimed for the duration (ADR-044): a run holding this resource is
   * creating that same v1, and a migration is never worth waiting for — a
   * refused resource counts as skipped and the next run of the job picks it up.
   * Since the version lock went (ADR-044 §5), the claim is the only thing
   * keeping the migration and a live run off the same resource.
   */
  private async createFirstVersion(
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
      // Against the row as it is *now*: the scan happened earlier, and since
      // then a pipeline run may have created v1, or a newer run may have moved
      // the pointer — which means the object this row described is no longer
      // the content, and v1 must not be made to name it.
      const [current] = await readBeforeFirstVersion(this.db, r.id)
      if (!current || current.versioned) return false
      if (!current.storageKey || current.storageKey !== r.storageKey) return false

      // Measured rather than taken from the row: this is pre-existing data,
      // and `upload-complete` used to accept any string as a hash. Read off the
      // live object, which v1 is about to name (ADR-043 §1) — there is no copy
      // of it to read instead.
      const created = await digestStream(await storage.download(current.storageKey))

      // Normalize the row to the measurement when the stored values were never
      // the real ones; refusing those rows instead would leave the migration
      // permanently incomplete. Guarded on the pointer, since a pipeline run
      // may have published newer content while this measured — its hash
      // describes that content and must not be overwritten with a measurement
      // of the object it replaced.
      if (created.hash !== r.hash || created.size !== r.size) {
        await this.db
          .update(resource)
          .set({ hash: created.hash, size: created.size })
          .where(and(eq(resource.id, r.id), eq(resource.storageKey, current.storageKey)))
      }

      const inserted = await insertVersionIfHeld(this.db, claim, {
        resourceId: r.id,
        version: 1,
        storageKey: current.storageKey,
        size: created.size,
        hash: created.hash,
        origin: versionOrigin(r.urlType),
        schema: r.schemaTrusted ? (r.schema ?? null) : null,
      })
      return inserted
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
    // One resource in, so at most one claim out. None means the resource is
    // gone, which is not a refusal — there is nothing left to give a v1 to.
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
    restore?: { version: number; snapshot: number } | null
  ): Promise<void> {
    // Never ingested: the lake holds nothing of this version, so there is
    // neither anything to roll back nor anything to free. Opening a session
    // costs extension loads and a catalog ATTACH — not worth it to find that
    // out, and most resources are not tabular.
    if (!lake || purgedSnapshot === null) return
    const table = lakeTableName(resourceId)
    await withLakeSession(lake, async (session) => {
      // Nothing to move for a middle version: the live contents already
      // describe a version that survives. The reclaim below still runs — another
      // resource's purge may have left snapshots behind when it failed partway.
      if (restore !== undefined) {
        await withLakeIngestLock(this.db, async (tx) => {
          if (restore === null) {
            if (await lakeTableExists(session, table)) await dropLakeTable(session, table)
            return
          }
          // Recorded against the version it now holds, like every other move of
          // this table — an ingest that read the old id would rebase off it.
          await standLakeTableOn(tx, session, { resourceId, ...restore })
        })
      }
      // The row being purged is `purging`, which the reclaim's retained set
      // excludes along with `purged` — so its snapshot reads as unreferenced
      // without needing a special case.
      await reclaimInSession(this.db, session)
    })
  }

  /**
   * `false` when the lake is owed a reconcile this call could not do, `null`
   * when it is owed nothing — the two halves of a refused repair.
   */
  private async lakeOwed(resourceId: string, deps: { lake?: LakeConfig }): Promise<false | null> {
    if (!deps.lake) return null
    const live = await this.newestActiveVersion(this.db, resourceId)
    return (await lakeStandsAhead(this.db, resourceId, live?.ducklakeSnapshotId ?? null))
      ? false
      : null
  }

  /**
   * Bring the lake table back in line with the version layer 1 now points at
   * (ADR-043 layer 2).
   *
   * A revert moves layer 1 back without touching layer 2, so the table is left
   * holding the rows of a version nothing points at any more. Nothing reads it
   * today — the diff resolves both sides to their own snapshots, which is why
   * ii-a never noticed — but that is a property of the one reader there happens
   * to be, not a guarantee. ii-b's `MERGE` takes the table's current contents as
   * its base, so leaving it means merging the next version onto retracted rows.
   *
   * Reported rather than thrown, like the rest of what follows the pointer move:
   * past it the retraction has happened, and failing the revert here invites a
   * retry of the one step that is not safe to repeat. `repairDerivatives` runs
   * this again.
   *
   * **Idempotent, and that is what the recorded snapshot buys.** The rollback
   * lands the destination's rows under a *new* snapshot, which is written back
   * onto the destination's row. "Is any version's snapshot above the live one's"
   * then answers "does the table still hold something the resource stepped off",
   * and answers it no once this has run — so a resend, a repair, and the standing
   * repair can all ask without rewriting a table that already stands where it
   * should. Recorded after the rollback and inside the same lock, so a failure in
   * between leaves the old id and the next caller does it again.
   *
   * Null when there is nothing this can put back, which is three cases:
   *
   * - no lake configured
   * - the destination never reached the lake. Stepping the versions above it off
   *   makes it outstanding again — both `pendingLakeIngestQuery` and the ingest's
   *   own check count only *active* newer versions as having overtaken it — so
   *   the sweep loads it rather than this rolling anywhere
   * - the resource was emptied, so no version is left to stand on. The table
   *   keeps the last ingested version's rows rather than being dropped: those
   *   versions are superseded rather than purged, and the diff still resolves
   *   each to its own snapshot. Nothing resolves to the table's head
   *
   * The caller must hold the resource's claim: the destination is read outside
   * the catalog lock, and a run that ingests a newer version in between would
   * otherwise have its work rolled away with nothing left to queue it again.
   */
  private async reconcileLakeToLive(
    resourceId: string,
    lake: LakeConfig | undefined,
    live: { version: number; ducklakeSnapshotId: number | null } | null,
    log: Logger
  ): Promise<boolean | null> {
    const toSnapshot = live?.ducklakeSnapshotId ?? null
    if (!lake || live === null || toSnapshot === null) return null
    // Inside the reporting `try` along with the rollback: this runs past the
    // pointer move, where throwing would fail a revert that has already
    // happened and leave the resend answering from `settledRevert`.
    try {
      if (!(await lakeStandsAhead(this.db, resourceId, toSnapshot))) return null

      await withLakeSession(lake, (session) =>
        withLakeIngestLock(this.db, async (tx) => {
          await standLakeTableOn(tx, session, {
            resourceId,
            version: live.version,
            snapshot: toSnapshot,
          })
        })
      )
      return true
    } catch (err) {
      log.error({ err, resourceId }, 'Content reverted, but the lake still holds its rows')
      return false
    }
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
   * Claim a version for purge: active or superseded → purging, recording who/why
   * durably on the row (ADR-028 pattern). Idempotent — a version already
   * purging/purged is returned unchanged and should not be re-enqueued.
   *
   * Superseded counts because a revert does not destroy anything: content
   * created from a file that should never have been served survives it, and
   * purging that version on its own is the rung above (ADR-044 §4). Refusing
   * here would make the one version most likely to need destroying the one
   * version that cannot be.
   *
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

      if (row.state !== 'active' && row.state !== 'superseded') {
        return { claimed: false, view: toView(row) }
      }

      // One at a time per resource, refused by the partial unique index rather
      // than by looking first: a look and a write are two steps, and two claims
      // for different versions take different rows, so both would look before
      // either wrote. Refused rather than queued — a purge is a rare and
      // deliberate act, and "another version of this resource is being purged"
      // is something the person asking can act on.
      let updated: typeof resourceVersion.$inferSelect | undefined
      try {
        ;[updated] = await tx
          .update(resourceVersion)
          .set({
            state: 'purging',
            purgedBy: userId,
            purgeReason: reason,
            updated: sql`NOW()`,
          })
          .where(eq(resourceVersion.id, row.id))
          .returning()
      } catch (err) {
        if (isOnePurgingViolation(err)) {
          throw new ConflictError(
            `Another version of ${resourceId} is being purged; retry when it has finished`
          )
        }
        throw err
      }

      await tx.insert(auditLog).values({
        entityType: 'resource_version',
        entityId: row.resourceId,
        action: 'purge_request',
        userId,
        changes: { version, reason },
      })

      return { claimed: true, view: toView(updated!) }
    })
  }

  /**
   * Execute a claimed purge (state must be 'purging'). Runs in the worker so it
   * retries on failure. Idempotent: a row not in 'purging' is a no-op.
   *
   * Deletes the object the version owns — one version, one object (ADR-046 §3),
   * so nothing else is describing it. If it was the live version, rolls the
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
    // Held for the whole purge (ADR-044). Interpret writes its preview to storage
    // before the database learns of it, and a version built from an object
    // another already owns copies it before inserting the row; a run inside
    // either window would write those
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

    // Whether the live pointer is standing on this version — the only reason
    // it has to move, and the only reason the object it names has to be
    // destroyed along with the version file. Asked of the pointer rather than
    // inferred from version order: a revert leaves the live content below rows
    // that outrank it, so "nothing active sits above this" answered yes for
    // versions that were not live and no for ones that were.
    const isLive =
      pkgRow !== undefined &&
      (await this.liveVersion(resourceId, pkgRow, ['active', 'superseded', 'purging'])) === version

    // The object this version owns, destroyed before the pointer is moved off
    // it. A legal deletion falls the safe way round: interrupted here, live
    // names an object that is gone — unservable — rather than one that is not.
    await deps.storage.delete(row.storageKey)

    let rolledBack = false
    if (isLive && pkgRow) {
      // Everything this purge owes about the content happens before the pointer
      // moves. The pointer is what `isLive` reads, so moving it is what hides
      // that any of it is still owed: a purge interrupted after came back
      // reading itself as a middle version and took the branch that does none of
      // it — leaving the preview, the search index and the lake's current
      // contents serving what had just been legally deleted, under a row that
      // then said 'purged'. Done first, an interruption can only leave work
      // already finished.
      await this.discardDerivedArtifacts(resourceId, deps.storage)
      if (deps.search) await deps.search.deleteContent(resourceId)
      // Said on the row as well: the regeneration reads it to decide whether it
      // has anything to derive, and clearing the preview alone leaves that
      // answer resting on a side effect of another statement.
      await markContentUnindexed(this.db, { resourceId })
      await this.setPurgeRebuildPending(resourceId, true)

      // Read rather than taken from the restore, so layer 2 can be moved off the
      // purged snapshot while the pointer still says this is outstanding. Null
      // empties the resource, and takes the lake table with it. This row is
      // already out of the active set (`purging`), so it cannot restore itself.
      const prev = await this.newestActiveVersion(this.db, resourceId)
      await this.purgeFromLake(
        resourceId,
        deps.lake,
        row.ducklakeSnapshotId,
        prev?.ducklakeSnapshotId == null
          ? null
          : { version: prev.version, snapshot: prev.ducklakeSnapshotId }
      )

      // The same row layer 2 was just set to, handed over rather than looked up
      // again — see the parameter for what a second look can find instead.
      rolledBack = (await this.restoreLiveFromVersions(this.db, resourceId, pkgRow, prev)) !== null

      // The object the purged content was being served from, deleted now rather
      // than left to the sweep: a purge is a legal deletion, so cutting off a
      // reader that already resolved that key is the point.
      //
      // Unless it is the version file already deleted above: live standing on
      // the version being purged is exactly what `isLive` means now that the
      // pointer answers it (ADR-043 §1), so the two keys are the same one.
      if (pkgRow.storageKey && pkgRow.storageKey !== row.storageKey) {
        await deps.storage.delete(pkgRow.storageKey)
      }
    } else {
      // A middle version: the live contents are already free of it, and its
      // derivatives describe content this purge does not touch. Only its own
      // snapshot still holds the rows and must be reclaimed (ADR-043 §5).
      await this.purgeFromLake(resourceId, deps.lake, row.ducklakeSnapshotId)
    }

    // Regenerate preview/index from whatever the resource serves now. The
    // Version step's change gate sees that content as the latest active version
    // and skips, so no spurious version is created.
    //
    // A rebuild, never an ordinary run: Fetch re-reads an external URL, and the
    // URL a resource is purged over is the one still serving what was purged —
    // an ordinary run would publish it straight back and file it as a new
    // version. ADR-044 §4 makes the same point about reverts.
    //
    // Asked of the row rather than of this attempt: the one that has to finish
    // an interrupted purge is a later one, which rolled nothing back and would
    // conclude it owes nothing. Its own marker rather than `contentIndexed`,
    // which an unsupported format or a failed Index sets for reasons that have
    // nothing to do with a purge.
    if (await this.purgeRebuildPending(resourceId)) {
      if (await this.hasLiveContent(resourceId)) {
        await new PipelineService(this.db, deps.queue).enqueue(resourceId, { rebuildOnly: true })
      }
      await this.setPurgeRebuildPending(resourceId, false)
    }

    await this.db
      .update(resourceVersion)
      .set({
        state: 'purged',
        purgedAt: sql`NOW()`,
        updated: sql`NOW()`,
        // The tombstone must not point at content, and layer 2 is the one
        // reference left to drop.
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
   * so a version already created from the wrong content survives this and has
   * to be purged on its own. That is the ladder working as intended, not a gap.
   *
   * The stop and the claim are one statement. Released and then re-taken, the
   * resource is free for the moment in between, and a job already waiting on it
   * would start writing over the very content being retracted.
   *
   * **Absolute, and guarded by what the caller saw.** Two separate problems, two
   * separate fields.
   *
   * `restoreTo` is where the content goes, not how many rungs to step. Relative,
   * the operation run twice is not the operation run once — the second pass
   * steps off what the first restored — and a response lost after the pointer
   * moved leaves a caller who cannot tell which they are about to do. Stating
   * the destination makes a resend land in the same place, with nothing
   * remembered between attempts and no operation ledger to keep.
   *
   * `ifLiveRevision` is what stops a request delayed past a newer upload from
   * retracting content its caller never saw. Idempotency would not give that:
   * "have I already done this" and "is this still the thing I was shown" are
   * different questions, and answering only the first turns a stale request into
   * a silent overwrite.
   *
   * - already at `restoreTo` → answered by {@link settledRevert}, which does
   *   not take the claim and states there what a resend does and does not redo
   * - the generation matches → do the work
   * - otherwise → 409
   *
   * @returns the version restored, `null` when the resource is empty, plus the
   *   {@link LadderOutcome} halves — `cleared: false` when the content was
   *   retracted but its derivatives outlived it, `queued: false` when the
   *   rebuild that puts them back never reached the queue. Either is repaired by
   *   {@link repairDerivatives}, never by reverting again.
   */
  async revertLiveContent(
    resourceId: string,
    target: { restoreTo: number | null; ifLiveRevision: string },
    deps: {
      storage: StorageAdapter
      search?: SearchAdapter
      queue: QueueAdapter
      lake?: LakeConfig
      logger?: Logger
    }
  ): Promise<LadderOutcome & { cancelled: boolean; restored: number | null }> {
    const log = deps.logger ?? createLogger({ name: 'api' })

    // Everything that can end in "do not proceed" is settled before the claim,
    // because taking it stops whatever is running (ADR-044 §4). A refusal that
    // waits until after has already cost a run its work.
    //
    // The destination has to be a version the resource can stand on. Left
    // unchecked, naming a superseded or missing one supersedes whatever is above
    // it and then restores some *other* version — or empties the resource — and
    // reports success. Superseded is refused rather than resolved: stepping back
    // onto content an earlier revert set aside is redo, which this ladder does
    // not have. Nothing can slip in behind this: making it superseded is itself
    // a revert, which moves the generation the takeover is conditioned on.
    if (target.restoreTo !== null) {
      const [row] = await this.db
        .select({ state: resourceVersion.state })
        .from(resourceVersion)
        .where(
          and(
            eq(resourceVersion.resourceId, resourceId),
            eq(resourceVersion.version, target.restoreTo)
          )
        )
        .limit(1)
      if (!row) throw new NotFoundError('Resource version', `${resourceId}/v${target.restoreTo}`)
      if (row.state !== 'active') {
        throw new ConflictError(
          `Version ${target.restoreTo} of ${resourceId} is ${row.state}; it cannot be restored`
        )
      }
    }

    // A resend can land while the rebuild its own first attempt queued is still
    // going, so this too is answered without taking the claim.
    const settled = await this.settledRevert(resourceId, target, deps, log)
    if (settled) return settled

    const { cancelled, restored, cleared } = await withClaimFromRun(
      this.db,
      resourceId,
      'revert',
      async (_claim, cancelled) => {
        // Read as the generation the caller named, not just by id. The takeover
        // checked it, but an upload takes no claim (ADR-044 §6) and can publish
        // in the moment after — and then this would read the new object as the
        // content to retract, with the pointer CAS below agreeing, retracting an
        // upload the caller never saw.
        const [current] = await this.db
          .select({
            packageId: resource.packageId,
            storageKey: resource.storageKey,
            hash: resource.hash,
          })
          .from(resource)
          .where(
            and(eq(resource.id, resourceId), eq(resource.contentRevision, target.ifLiveRevision))
          )
          .limit(1)
        if (!current) {
          throw new ConflictError(
            `Resource ${resourceId} has changed since it was read; retry from its current state`
          )
        }

        // Step off before stepping back: the restore lands on the newest active
        // version at or below the destination, so everything above it has to
        // leave that set first (ADR-044 §4).
        //
        // One transaction, because the marks and the pointer are both database
        // writes now. They used to have a storage copy between them, so a
        // restore that failed had to put the marks back by hand — and the state
        // it was undoing is the one this whole rung exists to prevent: the
        // resource serving content whose version is no longer the highest
        // active one, with nothing that re-runs a revert to repair it. With the
        // copy gone (ADR-043 §1) there is nothing to put back; a failure never
        // committed the marks.
        const restored = await this.db.transaction(async (tx) => {
          await this.stepOffAbove(tx, resourceId, target.restoreTo)
          return this.restoreLiveFromVersions(tx, resourceId, current)
        })

        // The retraction has happened: the pointer names the restored content
        // and the versions stepped off are out of the active set. Both of these
        // destroy what described it and touch nothing the other does, and both
        // report rather than throw — so neither waits on the other, and the
        // request pays the slower one instead of the sum. The lake is safe here
        // because the claim is still held: no run of this resource can ingest
        // between the pointer landing and the lake following it.
        const [cleared, followed] = await Promise.all([
          this.discardRetracted(resourceId, deps, log),
          this.reconcileLakeToLive(resourceId, deps.lake, restored, log),
        ])

        return {
          cancelled,
          restored: restored?.version ?? null,
          // One field, because both halves say the same thing: something that
          // described the retracted content outlived it.
          cleared: cleared && followed !== false,
        }
      },
      // Refused inside the takeover statement rather than after it: told no
      // here, this call has already stopped whatever was running.
      target.ifLiveRevision
    )

    // Rebuild the derivatives from the restored content, once the claim is
    // back: enqueued inside it, the run that picks the job up finds the
    // resource held and puts itself back on the queue for another 30 seconds.
    //
    // The Version step's change gate reads the highest *active* version, which
    // the step-off above made the restored one, so it matches and no spurious
    // version is created. Nothing to rebuild from when the resource was
    // emptied.
    // Null rather than false when the resource was emptied: there is no content
    // for a run to rebuild from, so nothing was owed.
    const queued = restored ? await this.queueRebuild(resourceId, deps, log) : null

    return { cancelled, restored, cleared, queued }
  }

  /**
   * What a revert has to be told, worked out here rather than by the caller.
   *
   * Served with the pipeline status, because that is what the revert control
   * reads — the client echoes both back and holds no rule of its own about
   * where a step back lands (ADR-044 §4).
   *
   * `revertTarget` is the newest active version below the one the content is
   * standing on; when no version holds the live content — an upload no run has
   * created — it is the newest active version, since there is nothing to step
   * off and that is where a step back goes. Null means the revert empties the
   * resource.
   */
  async revertContext(
    resourceId: string
  ): Promise<{ revertTarget: number | null; liveRevision: string }> {
    const [row] = await this.db
      .select({
        storageKey: resource.storageKey,
        hash: resource.hash,
        revision: resource.contentRevision,
      })
      .from(resource)
      .where(eq(resource.id, resourceId))
      .limit(1)
    const standing = await this.liveVersion(
      resourceId,
      { storageKey: row?.storageKey ?? null, hash: row?.hash ?? null },
      ['active']
    )
    const [below] = await this.db
      .select({ version: resourceVersion.version })
      .from(resourceVersion)
      .where(
        and(
          eq(resourceVersion.resourceId, resourceId),
          eq(resourceVersion.state, 'active'),
          standing === undefined ? sql`TRUE` : sql`${resourceVersion.version} < ${standing}`
        )
      )
      .orderBy(desc(resourceVersion.version))
      .limit(1)
    return { revertTarget: below?.version ?? null, liveRevision: row?.revision ?? '' }
  }

  /**
   * The answer for a revert whose content is already where it asked to be, or
   * null when there is work to do.
   *
   * Asked without the claim, and that is the point: taking it stops whatever is
   * running (ADR-044 §4). A resend arriving while the rebuild its own first
   * attempt queued is still going would otherwise kill that run before finding
   * out it had nothing to do — and then not re-queue it, because nothing moved.
   *
   * Nothing is cleaned up here **unless the resource is empty**. The ordinary
   * case leaves it alone because the derivatives describe the restored content,
   * and a resend landing after the rebuild would delete the preview and index
   * it should be keeping. An empty resource has no such content: anything left
   * describing it is the retracted file, so deleting it is right whenever it is
   * asked. That is the repair path for an emptying revert whose search delete
   * failed, which has no other — reprocessing cannot rebuild from no content,
   * and for an external URL it would fetch the retracted file back.
   */
  private async settledRevert(
    resourceId: string,
    target: { restoreTo: number | null },
    deps: {
      storage: StorageAdapter
      search?: SearchAdapter
      queue: QueueAdapter
      lake?: LakeConfig
    },
    log: Logger
  ): Promise<(LadderOutcome & { cancelled: boolean; restored: number | null }) | null> {
    const [current] = await this.db
      .select({
        storageKey: resource.storageKey,
        hash: resource.hash,
        revision: resource.contentRevision,
      })
      .from(resource)
      .where(eq(resource.id, resourceId))
      .limit(1)
    if (!current) return null

    const standing = current.storageKey
      ? ((await this.liveVersion(resourceId, current, ['active'])) ?? null)
      : null
    const settled =
      standing === target.restoreTo && (current.storageKey !== null) === (standing !== null)
    if (!settled) return null
    if (current.storageKey !== null) {
      // Settled, but "the content is in the right place" does not say the
      // derivatives were rebuilt: the attempt that moved it may have failed to
      // queue that, and then died before saying so. Queue it again — a rebuild
      // repeated over content already there costs a pass, and repairs a preview
      // and index that never came back.
      return {
        cancelled: false,
        restored: standing,
        // Nothing left to clear — the attempt that moved the content took the
        // derivatives with it, which is why this one is settled at all. Layer 2
        // is the exception: the attempt may have died between the pointer move
        // and the reconcile, and the rebuild queued below cannot stand in for it
        // — it makes no version, so the Lake step finds nothing outstanding.
        // Only reported here, never done: the reconcile needs the claim, and
        // taking it is exactly what this path exists to avoid. `false` puts it
        // on `repairDerivatives`, which does take one.
        cleared: await this.lakeOwed(resourceId, deps),
        queued: await this.queueRebuild(resourceId, deps, log),
      }
    }

    const cleaned = await this.clearEmptied(resourceId, current.revision, deps, log)
    // Filled up in between: no longer settled, and the caller's generation is
    // stale with it. The path below is where that is answered.
    if (cleaned === null) return null
    return { cancelled: false, restored: null, cleared: cleaned, queued: null }
  }

  /**
   * Queue the rebuild that puts the derivatives back, reporting rather than
   * throwing.
   *
   * A rebuild, not an ordinary run: Fetch re-reads an external URL, so for a
   * resource reverted *because* that URL served the wrong thing, the job queued
   * to finish the retraction would publish it straight back (ADR-044 §4).
   *
   * Best-effort because the retraction has already happened — failing the
   * response over a queue that is down misstates an outcome that stands.
   */
  private async queueRebuild(
    resourceId: string,
    deps: { queue: QueueAdapter },
    log: Logger
  ): Promise<boolean> {
    try {
      await new PipelineService(this.db, deps.queue).enqueue(resourceId, { rebuildOnly: true })
      return true
    } catch (err) {
      log.error({ err, resourceId }, 'Content is in place, but its rebuild was not queued')
      return false
    }
  }

  /**
   * Delete what an emptied resource still has describing the content it no
   * longer serves.
   *
   * Emptiness is what makes this safe, so it has to still hold when the delete
   * happens: an upload and the run behind it can land between reading it and
   * here, and then those derivatives belong to the new content.
   *
   * Claimed as a job, not taken from a run. A run against an empty resource is
   * a fetch that has not published yet — still empty, still the same generation
   * — so a takeover would cancel exactly the run that was about to fill it, and
   * nothing here would re-queue it. Refused instead: whatever that run writes
   * replaces these derivatives anyway.
   *
   * The generation goes to the delete as well, because an upload takes no claim
   * (ADR-044 §6) and so changes the content from outside the claim entirely.
   *
   * @returns whether everything went, or null when the resource is no longer
   *   empty — which means this had nothing to do.
   */
  private async clearEmptied(
    resourceId: string,
    ifRevision: string,
    deps: { storage: StorageAdapter; search?: SearchAdapter },
    log: Logger
  ): Promise<boolean | null> {
    const clean = async () => {
      const [now] = await this.db
        .select({ storageKey: resource.storageKey, revision: resource.contentRevision })
        .from(resource)
        .where(eq(resource.id, resourceId))
        .limit(1)
      if (now?.storageKey != null || now?.revision !== ifRevision) return null
      return this.discardRetracted(resourceId, deps, log, ifRevision)
    }

    const outcome = await withResourceClaims(this.db, [resourceId], clean)
    // `false` covers being held by a run or another job: the cleanup is simply
    // not this call's to do, and the holder writes its own derivatives.
    return outcome.status === 'ran' ? outcome.result : false
  }

  /**
   * The repair a screen can offer without remembering anything (ADR-044 §4).
   *
   * Two shapes, because an emptied resource has no content to rebuild from and
   * queueing a run against one only fails. Which applies is read here rather
   * than asked of the caller: a control that has to be told which case it is in
   * is a control whose caller has to have kept the answer, and keeping it is
   * exactly what this exists to avoid.
   *
   * The two halves answer separately. Queueing a rebuild is not doing one — the
   * run can still fail — so `queued` says a job is on its way and nothing more,
   * while `cleared` says work actually finished. Reported as one field, a caller
   * would take an enqueue for a repair, which is the inference this whole rung
   * exists to refuse.
   *
   * Null is "this half had nothing to do", never a failure, so one predicate
   * reads every rung of the ladder: neither field is `false` (see
   * {@link LadderOutcome}).
   */
  async repairDerivatives(
    resourceId: string,
    deps: {
      storage: StorageAdapter
      search?: SearchAdapter
      queue: QueueAdapter
      lake?: LakeConfig
      logger?: Logger
    }
  ): Promise<LadderOutcome> {
    const log = deps.logger ?? createLogger({ name: 'api' })
    const [current] = await this.db
      .select({ storageKey: resource.storageKey, revision: resource.contentRevision })
      .from(resource)
      .where(eq(resource.id, resourceId))
      .limit(1)
    if (!current) throw new NotFoundError('Resource', resourceId)

    if (current.storageKey !== null) {
      // The rebuild cannot do this one: no new version comes of it, so the Lake
      // step has nothing outstanding to ingest and the table stays where the
      // revert left it.
      //
      // Under the claim, and the destination read under it too: a run publishing
      // a newer version between the read and the catalog lock would have its
      // ingest rolled away, and its row already carries a snapshot so nothing
      // queues it again.
      const held = await withResourceClaims(this.db, [resourceId], async () => {
        const live = await this.newestActiveVersion(this.db, resourceId)
        return this.reconcileLakeToLive(resourceId, deps.lake, live, log)
      })
      // Refused means a run holds the resource — and the one holding it may well
      // be the rebuild a previous press queued, which creates no version and so
      // writes nothing to the lake. Answering `null` there would take the warning
      // off the screen with the table still on retracted rows and no control left
      // to say so, so what was owed is asked again: owed and undone is `false`,
      // which keeps the repair on offer. The reconcile is idempotent, so pressing
      // it once more costs nothing when it has already run.
      const followed = held.status === 'ran' ? held.result : await this.lakeOwed(resourceId, deps)
      // Queued outside the claim, or the run that picks the job up finds the
      // resource held and puts itself back on the queue for another 30 seconds.
      return { queued: await this.queueRebuild(resourceId, deps, log), cleared: followed }
    }
    return {
      queued: null,
      cleared: (await this.clearEmptied(resourceId, current.revision, deps, log)) ?? true,
    }
  }

  /**
   * Destroy what described the retracted content, reporting rather than
   * throwing.
   *
   * Past the pointer move the retraction has happened, so a failure here does
   * not make the revert one — and saying it did invites a retry of the one
   * thing that is not safe to repeat. The two are attempted independently: a
   * storage failure that took the search delete with it would leave retracted
   * text reachable from the whole catalogue, which is the exposure this rung
   * exists to close.
   */
  private async discardRetracted(
    resourceId: string,
    deps: { storage: StorageAdapter; search?: SearchAdapter },
    log: Logger,
    ifRevision?: string
  ): Promise<boolean> {
    let ok = true
    for (const [what, run] of [
      ['derivatives', () => this.discardDerivedArtifacts(resourceId, deps.storage, ifRevision)],
      [
        'indexed content',
        async () => {
          await deps.search?.deleteContent(resourceId)
          // On the row too, so a later run does not read the retracted content
          // as still indexed
          await markContentUnindexed(this.db, { resourceId })
        },
      ],
    ] as const) {
      try {
        await run()
      } catch (err) {
        ok = false
        log.error({ err, resourceId }, `Content reverted, but its ${what} outlived it`)
      }
    }
    return ok
  }

  /**
   * Take every active version above a restore destination out of the active
   * set, and report which ones moved.
   *
   * Everything a restore to `below` steps off, because the restore lands on the
   * newest active version at or below it — left in that set, one of these would
   * be what it landed on. Null means "empty the resource", and everything
   * active is above that.
   *
   * Chosen and moved in one statement rather than read and then updated. The
   * `active` condition is a compare-and-swap: a purge claim takes a row lock in
   * its own transaction rather than this resource's claim, so it can move one
   * of these rows to `purging` in between. Read first, that row would be listed
   * as stepped off, silently fail to move, and then be put back on a rollback —
   * dragging it out of `purging`. Here it is simply not in the answer.
   */
  private async stepOffAbove(
    db: Pick<Database | Transaction, 'update'>,
    resourceId: string,
    below: number | null
  ): Promise<void> {
    await db
      .update(resourceVersion)
      .set({ state: 'superseded', updated: sql`NOW()` })
      .where(
        and(
          eq(resourceVersion.resourceId, resourceId),
          eq(resourceVersion.state, 'active'),
          below === null ? sql`TRUE` : sql`${resourceVersion.version} > ${below}`
        )
      )
  }

  /**
   * The version holding what is live now, if any version holds it.
   *
   * Where the live pointer is standing. The pointer names an object and a
   * version owns one (ADR-043 §1), so the answer is the version that owns the
   * live key — and only where nothing owns it, for rows written before versions
   * owned their objects, is it the newest version sharing the live hash.
   * Content can repeat (ADR-046 §3), so hash alone would answer yes for any
   * version holding those bytes.
   *
   * `states` is the caller's, because the two ask it from different places. A
   * revert asks among active versions: it is looking for what to step off, and
   * a version it superseded on an earlier pass must not be found again or
   * repeated content would leave it stepping in place. A purge asks among
   * everything not yet purged, because the row it is asking about is its own
   * and has already left `active`.
   *
   * Undefined when no version holds the live content — a file uploaded but
   * never created, or a creation the kill cut off. There is nothing to step
   * back from, and the newest version is the right place to land.
   */
  private async liveVersion(
    resourceId: string,
    live: { storageKey: string | null; hash: string | null },
    states: VersionState[]
  ): Promise<number | undefined> {
    // Asked without the state filter on purpose. A version outside the states
    // the caller asked about still owns the object — one being purged, say —
    // and the truthful answer is then "none of those", not the next row that
    // happens to share the hash. Filtered, a revert asking among active
    // versions while live stands on a `purging` one is told it is standing
    // somewhere older, and steps off everything down to and including it.
    if (live.storageKey) {
      const [owner] = await this.db
        .select({ version: resourceVersion.version, state: resourceVersion.state })
        .from(resourceVersion)
        .where(
          and(
            eq(resourceVersion.resourceId, resourceId),
            eq(resourceVersion.storageKey, live.storageKey),
            sql`${resourceVersion.state} <> 'purged'`
          )
        )
        .limit(1)
      if (owner) {
        return states.includes(owner.state as VersionState) ? owner.version : undefined
      }
    }

    // Nothing owns it: rows from before this change hold a copy of the live
    // object under a key of their own, so no version names what live names.
    // Hash is all there is to go on, and the newest match is the one stood on.
    if (!live.hash) return undefined
    const [row] = await this.db
      .select({ version: resourceVersion.version })
      .from(resourceVersion)
      .where(
        and(
          eq(resourceVersion.resourceId, resourceId),
          inArray(resourceVersion.state, states),
          eq(resourceVersion.hash, live.hash)
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
   * Restored through the same mover as every other writer (ADR-043), onto the
   * version's own object: nothing rewrites a version file, so there is nothing
   * to copy out first, and the move is the whole restore. That is what lets the
   * caller step versions off in the same transaction — the two used to have a
   * storage copy between them.
   *
   * Where it lands needs no bound from the caller: the version being retracted
   * has already left the active set by the time this runs — a purge marked it
   * `purging`, a revert `superseded` — so "the newest active version" is the
   * one below it. That is also what stops a second revert stepping *forward*
   * into a version an earlier one stepped off.
   *
   * @returns the version restored, or null when the resource was emptied.
   * @throws ConflictError when the pointer moved while this was running. Both
   *   callers go on to delete the preview and the indexed content, which
   *   describe whatever is live — so treating a lost move as a restore deletes
   *   the derivatives of the content that won. Uploads do not take the claim
   *   (ADR-044 §6), which is what leaves this reachable while one is held.
   */
  /**
   * A purge's own note that it has discarded the derivatives and not yet asked
   * for them back.
   *
   * Its own key because nothing else means the same thing. `contentIndexed` is
   * the nearest existing one, and it is set whenever indexing did not happen —
   * an unsupported format, a draft, a step that failed — none of which is a
   * purge owing a rebuild.
   */
  private async setPurgeRebuildPending(resourceId: string, pending: boolean): Promise<void> {
    await this.db.execute(sql`
      UPDATE resource_pipeline
      SET metadata = COALESCE(metadata, '{}'::jsonb) ||
            ${JSON.stringify({ purgeRebuildPending: pending })}::jsonb
      WHERE resource_id = ${resourceId}
    `)
  }

  private async purgeRebuildPending(resourceId: string): Promise<boolean> {
    const [row] = await this.db
      .select({
        pending: sql<boolean | null>`${resourcePipeline.metadata} -> 'purgeRebuildPending'`,
      })
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, resourceId))
      .limit(1)
    return row?.pending === true
  }

  /** Whether the resource still serves an object — read after a purge, which
   *  may have left it with nothing to derive from. */
  private async hasLiveContent(resourceId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ storageKey: resource.storageKey })
      .from(resource)
      .where(eq(resource.id, resourceId))
      .limit(1)
    return !!row?.storageKey
  }

  /** Newest version still standing, which a purge of the live one falls back to. */
  private async newestActiveVersion(db: Database | Transaction, resourceId: string) {
    const [prev] = await db
      .select()
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.state, 'active')))
      .orderBy(desc(resourceVersion.version))
      .limit(1)
    return prev ?? null
  }

  private async restoreLiveFromVersions(
    db: Database | Transaction,
    resourceId: string,
    current: { storageKey: string | null; hash?: string | null },
    /**
     * The version to restore onto, when the caller has already settled it.
     *
     * A purge moves layer 2 onto this version before moving the pointer, and the
     * two must land on the same one — the lake left holding a version nothing
     * points at is a version the next purge reads as a middle one and never
     * takes out. One purge at a time per resource means a second reading would
     * agree; handing the row over says so here, rather than leaving it resting
     * on an index in another file.
     */
    restoreTo?: typeof resourceVersion.$inferSelect | null
  ): Promise<typeof resourceVersion.$inferSelect | null> {
    const prev =
      restoreTo !== undefined ? restoreTo : await this.newestActiveVersion(db, resourceId)

    if (!prev) {
      // Through the mover like every other pointer move: unconditional, this
      // would clear a pointer an upload had moved since (uploads take no claim,
      // ADR-044 §6) and leave the retracted object tracked by nothing.
      const emptied = await publishLiveContent(db, resourceId, {
        key: null,
        previousKey: current.storageKey,
        hash: null,
        size: null,
        previousHash: current.hash ?? null,
      })
      if (!emptied) {
        throw new ConflictError(`Resource ${resourceId} changed while being emptied; retry`)
      }
      await this.adoptVersionInterpretation(db, resourceId, null)
      return null
    }

    // Straight at the version's own object, rather than a copy of it made to
    // carry the `resources/` prefix (ADR-043 §1). The bytes are the same either
    // way — nothing rewrites a version file — so the copy bought nothing but a
    // storage round trip between two database writes, which is what forced the
    // caller to step versions off and put them back on failure.
    const published = await publishLiveContent(db, resourceId, {
      key: prev.storageKey,
      previousKey: current.storageKey,
      hash: prev.hash!,
      size: prev.size!,
      previousHash: null,
      // The version's own, not the label the resource is carrying: a version is
      // those bytes read under that format (ADR-046 §6), so putting the content
      // back and leaving the label is putting back half of it. It is also what
      // stops the version gate seeing a difference and filing these bytes again
      // under a new number.
      format: prev.format,
    })
    // The mover parked this operation's own object on the way out, so nothing
    // is stranded by leaving.
    if (!published) {
      throw new ConflictError(`Resource ${resourceId} changed while being restored; retry`)
    }
    await this.adoptVersionInterpretation(db, resourceId, prev)
    return prev
  }

  /**
   * Point the resource's cached interpretation at the version now live.
   *
   * `resource_pipeline.metadata.schema` is the live version's columns and
   * `sourceHash` is the proof it describes those bytes — readers compare it to
   * `resource.hash`. Left alone, restoring puts back the content and leaves both
   * describing the version just retracted: the same half-restore that carrying
   * `format` across avoids, and the one the caller cannot see, because the
   * suggestion path reads the schema on its own (`getSchema`) without the
   * preview key whose absence makes the query path refuse.
   *
   * Taken from the version rather than derived again. A version file never
   * changes, so its interpretation cannot have — the rebuild the caller queues
   * arrives at the same answer, minutes later and only if it completes.
   *
   * A version with no interpretation (non-tabular, or never interpreted) leaves
   * the resource with none, which is what it has.
   */
  private async adoptVersionInterpretation(
    db: Database | Transaction,
    resourceId: string,
    restored: { schema: ResourceSchema | null; hash: string | null } | null
  ): Promise<void> {
    const schema = restored?.schema ?? null
    await db.execute(sql`
      UPDATE resource_pipeline
      SET metadata = ${
        schema
          ? sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
              schema,
              sourceHash: restored!.hash,
            })}::jsonb`
          : sql`COALESCE(metadata, '{}'::jsonb) - 'schema' - 'sourceHash'`
      },
          updated = NOW()
      WHERE resource_id = ${resourceId}::uuid
    `)
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
   * Destroyed immediately for both callers: a purge because destroying it is
   * the point, a revert because the artifacts describe the very file the caller
   * asked to stop serving. But the pointer is cleared and the key parked in one
   * statement first (ADR-045 §4), so a storage delete that fails is repaired by
   * the sweep within the hour rather than leaving an extract of retracted
   * content in the bucket with nothing naming it and nothing to reclaim it.
   * That is the only durable repair a revert with no version left to restore
   * has — there is no content for a pipeline run to rebuild from.
   *
   * Each pointer is cleared only if it still names the key that was read, the
   * way every other pointer here moves: a run taken over for being stale could
   * have written a newer preview since, and clearing that would take its object
   * away from it.
   */
  private async discardDerivedArtifacts(
    resourceId: string,
    storage: StorageAdapter,
    ifRevision?: string
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

    const detached = await this.db.execute(sql`
      WITH cleared AS (
        UPDATE resource_pipeline
        SET preview_key = CASE
              WHEN preview_key IS NOT DISTINCT FROM ${pipe!.previewKey}::text THEN NULL
              ELSE preview_key END,
            metadata = CASE
              WHEN metadata ->> 'textHeadKey' IS NOT DISTINCT FROM ${pipe!.textHeadKey}::text
              THEN metadata - 'textHeadKey'
              ELSE metadata END,
            updated = NOW()
        WHERE id = ${pipe!.id}::uuid AND ${onRevision(resourceId, ifRevision)}
        RETURNING id
      ),
      parked AS (
        INSERT INTO orphaned_object (key, expires_at)
        SELECT v.key, ${PARKED_UNTIL}
        FROM (VALUES ${sql.join(
          keys.map((k) => sql`(${k}::text)`),
          sql`, `
        )}) AS v(key), cleared
        ON CONFLICT (key) DO NOTHING
      )
      SELECT id FROM cleared
    `)

    // Nothing detached means the caller's premise expired between reading it
    // and here, so these keys are something else's now.
    if (detached.rows.length === 0) return

    // The records above are the safety net, not the plan: these objects go now.
    // A sweep that finds them already gone deletes nothing and drops the record.
    await storage.deleteMany(keys)
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
