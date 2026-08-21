/**
 * KUKAN Resource Version Service
 * Read + purge-claim logic for immutable canonical file versions (ADR-043, layer 1).
 * Purge *execution* (file deletion, state → purged) runs in the worker via executePurge.
 */

import { randomUUID } from 'node:crypto'
import { digestStream } from '@kukan/shared/hash-node'
import { eq, and, countDistinct, desc, exists, inArray, ne, sql } from 'drizzle-orm'
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
  getStorageKey,
  primaryKeyOf,
  sameKeyColumns,
  sameVersionIdentity,
  LAKE_INGEST_JOB_TYPE,
  NotFoundError,
  ValidationError,
  MAX_PARQUET_SOURCE_SIZE,
  versionOrigin,
} from '@kukan/shared'
import type { ColumnSettings, NoTableReason, VersionIdentity, VersionOrigin } from '@kukan/shared'
import type { LakeConfig } from '@kukan/lake'
import {
  dropLakeTable,
  lakeTableExists,
  lakeTableName,
  restandLakeTable,
  withLakeSession,
} from '@kukan/lake'
import type { Logger, ResourceSchema } from '@kukan/shared'
import { createLogger } from '@kukan/shared'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { QueueAdapter } from '@kukan/queue-adapter'
import { lakeStandDown, withLakeIngestLock } from './lake-ingest'
import { reclaimInSession } from './lake-reclaim'
import {
  CLAIM_STALE_AFTER_MS,
  onRevision,
  staleClaim,
  stillHeld,
  withClaimFromRun,
  withResourceClaims,
  withResourceClaimsOrConflict,
  type ResourceClaim,
} from './pipeline-claim'
import { copyObject, publishLiveContent, PARKED_UNTIL, ownedByVersion } from './storage-pointer'
import { PipelineService } from './pipeline-service'
import { markContentUnindexed } from './content-index-record'

/**
 * `superseded` is legacy only: a revert publishes forward and never writes it
 * (ADR-044 §4), but rows from before that change keep it and are left alone.
 * Named here because the view carries whatever the row says — dropped from the
 * union, `toView`'s cast would assert something false, and a reader switching
 * exhaustively would miss the case the database can still hand it.
 */
export type VersionState = 'active' | 'purging' | 'purged' | 'superseded'
export type { VersionOrigin }

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
  /**
   * The version a revert named, for the one creator whose content comes from
   * inside the resource (ADR-044 §4). Omitted by the other two.
   */
  restoredFrom?: number | null
  /**
   * The format {@link schema} was produced under, when the schema comes from
   * another version's row.
   *
   * **A version is those bytes read that way** (ADR-046 §6), and this row takes
   * its own format off the resource as it stands. Carrying a schema across
   * those two is only right while the readings agree: a resource relabelled
   * since the schema was settled would otherwise record "today's format,
   * yesterday's columns", and relabelled to something non-tabular it also
   * leaves the layer-2 sweep, so nothing corrects it. Given, the schema is
   * written only where the formats match; omitted, it is written as passed.
   */
  schemaFormat?: string | null
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
      INSERT INTO resource_version (resource_id, version, storage_key, size, hash, origin, format,
                                    schema, restored_from, lake_key_columns)
      SELECT ${v.resourceId}::uuid, ${v.version}, ${v.storageKey}::text, ${v.size}::bigint,
             ${v.hash}::text, ${v.origin}, r.format,
             ${
               'schemaFormat' in v
                 ? sql`CASE WHEN r.format IS NOT DISTINCT FROM ${v.schemaFormat}::varchar
                            THEN ${v.schema ? JSON.stringify(v.schema) : null}::jsonb END`
                 : sql`${v.schema ? JSON.stringify(v.schema) : null}::jsonb`
             },
             ${v.restoredFrom ?? null}::integer,
             r.column_settings -> 'primaryKey'
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
 * Whether the version owning this object is on its way out.
 *
 * Not answerable with {@link objectAlreadyVersioned}: that one asks whether
 * anything owns the object, and its predicate counts a `purging` owner as an
 * owner — the opposite of the question here.
 *
 * Two callers, and they have to agree by construction, because both are asking
 * whether the bytes under this key are about to be destroyed. The version gate
 * asks before copying an object into a new version (copying content someone
 * asked to have destroyed files it under a number the purge does not
 * recognise), and a revert asks before answering that a resend is already where
 * it wanted to be.
 */
export async function objectOwnerIsPurging(
  db: Pick<Database | Transaction, 'select'>,
  key: string
): Promise<boolean> {
  const [owner] = await db
    .select({ id: resourceVersion.id })
    .from(resourceVersion)
    .where(and(eq(resourceVersion.storageKey, key), eq(resourceVersion.state, 'purging')))
    .limit(1)
  return owner !== undefined
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

/**
 * What a revert answers with, on top of the ladder's own halves.
 *
 * Two version numbers, because a revert now names one and creates another
 * (ADR-044 §4). `restored` is the destination the caller asked for and keeps
 * the meaning it has always had; `published` is the version carrying that
 * content forward, which did not exist before. Moving `restored` onto the new
 * number instead would leave the same response shape pointing at a different
 * version, with nothing for an older caller to notice.
 */
export interface RevertOutcome extends LadderOutcome {
  cancelled: boolean
  /** The version whose content is now live, as the caller named it. */
  restored: number | null
  /** The version issued to carry it, or null when nothing was issued. */
  published: number | null
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
const MIGRATION_CONCURRENCY = 2

/**
 * The interpretation the pipeline recorded, as the row holds it.
 *
 * A function, though it takes nothing and the fragment it builds is immutable:
 * as a `const` it reads `resourcePipeline` while this module is being imported,
 * and a unit test that mocks `@kukan/db` without that table then fails on the
 * import rather than on anything it meant to exercise.
 */
function pipelineSchema() {
  return sql<ResourceSchema | null>`${resourcePipeline.metadata} -> 'schema'`
}

/**
 * The number the next version of this resource takes.
 *
 * Counted across **all** rows, tombstones included: a purged version keeps its
 * number, and reusing it collides on the unique index. Read inside the caller's
 * transaction, which is what makes it good by the time the insert lands — the
 * resource claim keeps other writers off, and the two callers here hold one.
 */
async function nextVersionNumber(tx: Transaction, resourceId: string): Promise<number> {
  const [maxRow] = await tx
    .select({ version: resourceVersion.version })
    .from(resourceVersion)
    .where(eq(resourceVersion.resourceId, resourceId))
    .orderBy(desc(resourceVersion.version))
    .limit(1)
  return (maxRow?.version ?? 0) + 1
}

/**
 * Versions the revert before ADR-044 §4 stepped off, in one place.
 *
 * The count, the scan and the flip all ask for them, and the count is what the
 * dashboard reads: let it drift from the scan and the migration reports itself
 * finished with rows still to convert.
 */
function setAside() {
  return eq(resourceVersion.state, 'superseded')
}

/**
 * Whether {@link pipelineSchema} was built from the bytes the resource holds
 * now.
 *
 * **A failed interpretation keeps the previous preview and schema without
 * failing the run**, so a migration copying it unchecked pins an older
 * content's columns onto a version of different bytes. Worse where the stale
 * value is a schema with no columns: the layer-2 sweep passes over those for
 * good (`pendingLakeIngestQuery`), so the version would never be loaded and
 * nothing would say why. Unproven, a migration writes no schema and leaves it
 * to the ordinary re-interpretation, which is a path that exists.
 *
 * `'extract'` deliberately: this reads rows already written, and the fallback
 * only applies to previews from before the source hash existed — all of which
 * predate the rename (ADR-046). Matching `'interpret'` here would find none of
 * them.
 */
function schemaDescribesLiveContent(db: Database) {
  return sql<boolean>`(
    ${resourcePipeline.metadata}->>'sourceHash' = ${resource.hash}
    OR (
      ${resourcePipeline.metadata}->>'sourceHash' IS NULL
      AND ${resourcePipeline.status} = 'complete'
      AND ${exists(
        db
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
  )`
}

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
 * - a version the ingest has already refused over its key (`lake_ingest_reason`,
 *   spec §6.6). The reasons are the answer to reading the content, not a
 *   predicate over the row — a composite key's uniqueness is not in the frozen
 *   schema — so the refusal is recorded where this can see it. Written once and
 *   never cleared: the same bytes under the same key reach the same answer, and
 *   changing the key makes a version of its own for this to pick up
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
function pendingLakeIngestQuery(only?: { resourceId: string; version?: number }) {
  const forVersion =
    only === undefined
      ? sql``
      : sql`
    AND rv.resource_id = ${only.resourceId}::uuid${
      only.version === undefined ? sql`` : sql` AND rv.version = ${only.version}`
    }`
  // Interpolated at the end of a line, not on one of its own: empty, a line of
  // its own leaves the indentation behind as trailing whitespace in the SQL
  // this pins.
  return sql`
  SELECT rv.resource_id AS "resourceId", rv.version, rv.storage_key AS "storageKey", rv.size,
         rv.format
  FROM resource_version rv
  JOIN resource r ON r.id = rv.resource_id
  WHERE r.state = 'active'${forVersion}
    AND rv.state = 'active'
    AND rv.ducklake_snapshot_id IS NULL
    AND rv.lake_ingest_reason IS NULL
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

/**
 * A version as exposed through the API. Purged versions are tombstones: their
 * content-bearing fields (storageKey/hash/size/schema) are withheld.
 *
 * **`purgeReason` is not here at all** (issue #425). It is free text an
 * administrator writes about why content had to go, so for a takedown it can
 * describe — or quote — the very thing the purge was destroying, and this view is
 * readable by anyone who can read the resource. Withholding the content while
 * publishing the account of it is the wrong way round.
 *
 * Nothing is lost: the audit log records who purged what, when and why, and
 * accountability lives there. Dropped rather than gated on permission, because no
 * screen reads it — passing a viewer into {@link toView} to keep a value nobody
 * displays would be API surface for its own sake. `purgedAt` stays: version
 * numbers skip where a purge happened and that needs explaining, which a date
 * alone does without leaking anything.
 */
export interface VersionView {
  version: number
  origin: VersionOrigin
  state: VersionState
  /**
   * Whether this is the version the resource is serving right now.
   *
   * **Answered here because a client cannot answer it.** The live pointer names
   * an object, not a version, and two shapes defeat the rules a client would
   * reach for instead (spec §9.6, with an integration test each):
   *
   * - **"the highest version"** — purging the newest leaves its tombstone on top
   *   with live below it, and a row an old-style revert set aside outranks live
   *   for as long as it is unconverted (ADR-044 §4)
   * - **"the highest `active` version"** — not during a purge: live stands on a
   *   `purging` version until the worker moves the pointer, and every active
   *   version is then something else
   *
   * It is what a purge acts on, so the confirmation screen needs it to say what a
   * purge will do rather than describing every branch.
   *
   * **True now, not a promise about later.** Live can move between a read of this
   * and anything done about it — another run publishing, a concurrent revert — so
   * a screen that names the case still says it conditionally.
   */
  isLive: boolean
  /**
   * The version serving would land on if this one were purged.
   *
   * **Set only when {@link isLive}**, because only that purge moves serving at
   * all: taking any other version leaves the pointer, the preview and the index
   * where they are. Null therefore means either "not the version being served" or
   * "nothing would be left to serve" — the difference is `isLive`, which a caller
   * reading this has already.
   *
   * The other half of what the confirmation screen says, and here for the same
   * reason as {@link isLive}: it is a rule about which versions a restore may
   * stand on ({@link ResourceVersionService.newestActiveVersion}), and a client
   * that re-derived it would go stale the moment that rule changed — while its
   * own tests kept passing. It also stops depending on the client holding every
   * version, which a paginated list would break (spec §14.1 open issue 13).
   */
  purgeFallsBackTo: number | null
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
  /**
   * The version this one re-published, for the ones a revert issued (ADR-044
   * §4). Null everywhere else.
   *
   * On the view because the history is the only place that answers it: content
   * and its reading repeat by design (ADR-046 §3), so a client comparing hashes
   * would name whichever match it happened to pick.
   *
   * **Withheld on a tombstone**, like the hash it would otherwise reconstruct:
   * saying a purged version re-published v5 states that its content was
   * identical to v5, which is the check hiding the hash exists to prevent
   * (spec §9.4). The column stays on the row — this is exposure, not erasure.
   */
  restoredFrom: number | null
  created: Date
  /** When the version was retracted — the whole of what a tombstone says about it,
   *  since the reason is not exposed (see above). */
  purgedAt: Date | null
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

/**
 * @param serving - what the resource is standing on and where it would fall to,
 * both read once per snapshot and handed in rather than derived per row: see
 * {@link VersionView.isLive}. `standing` is the surviving versions a restore may
 * land on, newest first ({@link ResourceVersionService.newestActiveVersion}'s
 * rule over the same rows).
 * @param sourcePurged - whether the version this one re-published is a
 * tombstone. Its own parameter and required, unlike the redactions above it:
 * those are settled by the row in hand, this one by another row, and a default
 * would make a new call site disclose it by saying nothing.
 */
function toView(
  row: typeof resourceVersion.$inferSelect,
  serving: { live: number | null; standing: readonly number[] },
  sourcePurged: boolean
): VersionView {
  const purged = row.state === 'purged'
  const isLive = row.version === serving.live
  return {
    version: row.version,
    origin: row.origin as VersionOrigin,
    state: row.state as VersionState,
    isLive,
    // Only for the version being served: purging any other one leaves serving
    // where it is, so an answer there would name a move that does not happen.
    // Excluding this version itself, which is the one on its way out.
    purgeFallsBackTo: isLive ? (serving.standing.find((v) => v !== row.version) ?? null) : null,
    format: row.format,
    // Withhold content metadata for purged tombstones.
    size: purged ? null : row.size,
    hash: purged ? null : row.hash,
    schema: purged ? null : row.schema,
    noTableReason: purged ? null : noTableReason(row),
    // Withheld when *either* end is a tombstone, unlike the fields above, which
    // are settled by this row alone. "v8 re-published v5" states the two held
    // identical content — and with v5 purged and v8 alive, that hands over the
    // erased content, since v8 can still be downloaded (spec §9.4).
    restoredFrom: purged || sourcePurged ? null : row.restoredFrom,
    created: row.created,
    // No `purgeReason`: the row carries one, this view deliberately does not.
    purgedAt: row.purgedAt,
  }
}

/**
 * The states in which a version can be the one being served.
 *
 * Every state but `purged`, and `purging` is the one worth naming: a purge in
 * flight is still what the resource is serving until the worker moves the
 * pointer, so a reader that left it out would answer "something else is live"
 * for the whole of a purge. Shared so the view and the purge cannot drift into
 * two answers (spec §9.6).
 *
 * `superseded` is here because the state still exists in old rows: a revert
 * publishes forward and never writes it (ADR-044 §4), but nothing has migrated
 * what the scheme before wrote. **Reading it out is the migration's job, not a
 * predicate's** — every attempt to encode the difference here got one case or
 * another wrong.
 */
const SERVING_STATES: VersionState[] = ['active', 'superseded', 'purging']

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
   * Count resources still holding versions the revert before ADR-044 §4 set
   * aside. Zero is what lets `superseded` leave the language: while any remain,
   * code written for three states counts them as content being served.
   *
   * By resource rather than by row, because that is the unit converted — one
   * resource is one claim, one issue and one flip however many rows it holds.
   */
  async countUnconvertedReverts(): Promise<number> {
    const [row] = await this.db
      .select({ count: countDistinct(resourceVersion.resourceId) })
      .from(resourceVersion)
      .where(setAside())
    return row?.count ?? 0
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
        schema: pipelineSchema(),
        schemaTrusted: schemaDescribesLiveContent(this.db),
      })
      .from(resource)
      .leftJoin(resourcePipeline, eq(resourcePipeline.resourceId, resource.id))
      .where(this.unversionedWhere())

    // Skipped: something created, replaced or is holding the resource.
    const { done, skipped, failed } = await this.runMigrationUnits(rows, (r) =>
      this.createFirstVersion(r, deps.storage)
    )

    const { queued, failed: queueFailed } = await this.queuePendingLakeIngests(deps.queue)
    return { created: done, skipped, failed, queued, queueFailed }
  }

  /**
   * Run one unit per row, bounded, and tally the outcome.
   *
   * The protocol every migration unit here speaks: **true** did the work,
   * **false** left it for the next pass (something else holds the resource, or
   * moved it under this one), **throwing** failed. Per row rather than one
   * batched statement, so one unconvertible resource costs only itself.
   *
   * Shared because the accounting is the part that has to mean the same thing
   * across migrations — the dashboard reads "outstanding" from a count, and a
   * unit tallied as done when it was skipped shows an install as migrated when
   * it is not.
   */
  private async runMigrationUnits<T>(
    rows: T[],
    unit: (row: T) => Promise<boolean>
  ): Promise<{ done: number; skipped: number; failed: number }> {
    let done = 0
    let skipped = 0
    let failed = 0
    for (let i = 0; i < rows.length; i += MIGRATION_CONCURRENCY) {
      const results = await Promise.allSettled(rows.slice(i, i + MIGRATION_CONCURRENCY).map(unit))
      for (const res of results) {
        if (res.status === 'rejected') failed++
        else if (res.value) done++
        else skipped++
      }
    }
    return { done, skipped, failed }
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
   * Convert what the revert before ADR-044 §4 left behind (that section).
   *
   * That revert set the versions above its destination aside as `superseded`
   * and pointed live at the destination's own object. A revert now issues the
   * destination's content as a new version and moves no other row, so those
   * rows are the only place the old shape still exists — and every predicate
   * over version state has to be right about both worlds for as long as they
   * do. Six attempts at such a predicate opened six holes: it is a property of
   * the data, not of the predicate.
   *
   * **Every resource holding one is converted, with no shape left out.** One
   * exclusion keeps its rows for good, and the three states never arrive. That
   * includes deleted resources, whose rows are just as much rows.
   *
   * Idempotent and resumable: what to do is read off the rows as they stand, so
   * a converted resource asks for nothing and an interrupted pass resumes by
   * looking again.
   */
  async convertSetAsideVersions(deps: { storage: StorageAdapter; queue: QueueAdapter }): Promise<{
    /** Reached the new shape, whether or not that took issuing a version. */
    converted: number
    /** Held by a run, or overtaken mid-way — the next pass finds it again. */
    skipped: number
    failed: number
    /** Versions this pass issued, handed to the worker to load (ADR-046). */
    queued: number
    /** Versions the queue refused; the hourly sweep finds them again. */
    queueFailed: number
  }> {
    const rows = await this.db
      .selectDistinct({ resourceId: resourceVersion.resourceId })
      .from(resourceVersion)
      .where(setAside())

    const { done, skipped, failed } = await this.runMigrationUnits(rows, (r) =>
      this.convertSetAside(r.resourceId, deps.storage)
    )

    // The versions issued above are tabular content layer 2 has never seen, and
    // the flip makes set-aside rows candidates as well. Queued here rather than
    // left to the hourly sweep, and by this job rather than the backfill's own
    // call: the two run side by side, so a backfill that finished its scan
    // first would leave this pass's versions for the next hour.
    const { queued, failed: queueFailed } = await this.queuePendingLakeIngests(deps.queue)
    return { converted: done, skipped, failed, queued, queueFailed }
  }

  /**
   * Convert one resource: issue what it is serving as a version, then flip.
   *
   * **The issue goes first**, in a transaction of its own. The other order
   * shows the resource as "the label says the higher version, the content says
   * the lower" until the second write lands — the very breakage being removed.
   * This order opens no such window: once the content is issued the topmost
   * version owns live, and rows still saying `superseded` are only counted as
   * content being served, which is true of them.
   *
   * Nothing is re-read between the two. The question the issue answered — does
   * the topmost version own the live object — is one the flip cannot change,
   * since it moves neither version numbers nor tombstones, so a pass cut off in
   * between resumes by asking it again and finds only the flip outstanding.
   */
  private async convertSetAside(resourceId: string, storage: StorageAdapter): Promise<boolean> {
    return this.withClaimOrSkip(resourceId, async (claim) => {
      if (!(await this.issueLiveAsVersion(resourceId, claim, storage))) return false

      const flipped = await this.db
        .update(resourceVersion)
        .set({ state: 'active', updated: sql`NOW()` })
        .where(and(eq(resourceVersion.resourceId, resourceId), setAside(), stillHeld(claim)))
        .returning({ version: resourceVersion.version })
      // Nothing flipped means the claim went stale and was taken between the
      // issue and here — the rows are still set aside. Reported as work not
      // done, so the count the dashboard reads and the number this returns do
      // not disagree about the same resource.
      return flipped.length > 0
    })
  }

  /**
   * Put the live object under the newest version, whichever way it takes.
   *
   * Which way is decided by **who owns the live object**, and by nothing else:
   *
   * - the topmost version owns it, or nothing is being served — already the
   *   shape a revert leaves, so the flip is the whole conversion
   * - a lower version owns it — its content is issued as a new version, the
   *   same write a revert makes, by the same function
   * - no version owns it — the new version **takes that object** rather than
   *   copying it, which is what the rule says to do with an object nobody owns
   *   (ADR-043 §1-2). The pointer does not move either
   *
   * The third is the ordinary outcome of re-fetching an unchanged URL, so it is
   * not a legacy shape and cannot be skipped: leaving it out would leave the
   * `superseded` rows of every resource that reaches it, which is any of them
   * given time.
   *
   * @returns false when the resource was taken out from under this — the next
   *   pass converts it.
   */
  private async issueLiveAsVersion(
    resourceId: string,
    claim: ResourceClaim | null,
    storage: StorageAdapter
  ): Promise<boolean> {
    const [current] = await this.db
      .select({
        packageId: resource.packageId,
        storageKey: resource.storageKey,
        hash: resource.hash,
        size: resource.size,
        urlType: resource.urlType,
        schema: pipelineSchema(),
        schemaTrusted: schemaDescribesLiveContent(this.db),
      })
      .from(resource)
      .leftJoin(resourcePipeline, eq(resourcePipeline.resourceId, resource.id))
      .where(eq(resource.id, resourceId))
      .limit(1)
    // Serving nothing has nothing to issue — the shape an emptying revert
    // leaves, where flipping the rows back is the whole of it.
    if (!current?.storageKey) return true

    // Ownership is asked of the object, never of the hash: several versions can
    // hold the same bytes (ADR-046 §3), and the one that owns the object is the
    // one whose purge would destroy it. Tombstones own nothing, so they neither
    // answer this nor stand as the topmost row.
    const [topmost] = await this.db
      .select({ version: resourceVersion.version, storageKey: resourceVersion.storageKey })
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), ne(resourceVersion.state, 'purged')))
      .orderBy(desc(resourceVersion.version))
      .limit(1)
    // Already the shape a revert leaves.
    if (topmost?.storageKey === current.storageKey) return true

    const [owner] = await this.db
      .select({ version: resourceVersion.version })
      .from(resourceVersion)
      .where(
        and(
          eq(resourceVersion.resourceId, resourceId),
          eq(resourceVersion.storageKey, current.storageKey),
          ne(resourceVersion.state, 'purged')
        )
      )
      .limit(1)

    if (owner) {
      try {
        // The destination's object is the live one — the same key by the WHERE
        // above, which is why it is not read back off the row.
        const destination = { version: owner.version, storageKey: current.storageKey }
        // Not retracting: the destination already owns what is served, so the
        // bytes do not change and neither may the resource's label or its
        // interpretation.
        await this.publishVersionContent(resourceId, claim, destination, current, storage, false)
        return true
      } catch (error) {
        // The destination was claimed for purge, or the pointer moved, while
        // this ran. Both leave the copy to the sweep and the resource to the
        // next pass — neither is a failure of the migration.
        if (error instanceof ConflictError) return false
        throw error
      }
    }

    // Measured, not taken from the row, for the reason the v1 pass gives: this
    // is pre-existing data, `upload-complete` used to accept any string as a
    // hash, and `promoteUpload` writes the size the client claimed. **There is
    // no copy to read instead** — this branch files the live object itself, and
    // the numbers it records are what `sameVersionIdentity` and the live guess
    // then compare against.
    const measured = await digestStream(await storage.download(current.storageKey))

    return this.adoptLiveObject(resourceId, claim, {
      storageKey: current.storageKey,
      ...measured,
      stale: measured.hash !== current.hash || measured.size !== current.size,
      origin: versionOrigin(current.urlType),
      schema: current.schemaTrusted ? (current.schema ?? null) : null,
    })
  }

  /**
   * Record the live object as the newest version, without copying it.
   *
   * The pointer is locked and re-read first. An upload takes no claim (ADR-044
   * §4), so it is the one write that can move the pointer while this holds the
   * resource, and this version would then name content the resource no longer
   * serves. Locking the row puts the two in an order, since moving the pointer
   * updates it. **The object itself is not at risk either way**: the sweep asks
   * `resource_version.storage_key` before deleting anything (ADR-045), so a
   * version that lands takes the key back off the reclamation list whatever
   * order the two committed in.
   *
   * `stale` says the measurement disagreed with the row. The row is then
   * corrected under the same lock: the live hash is what the version gate and
   * the live guess compare against, so leaving the version truthful and the
   * resource wrong would answer "different content" forever.
   */
  private async adoptLiveObject(
    resourceId: string,
    claim: ResourceClaim | null,
    live: {
      storageKey: string
      hash: string
      size: number
      stale: boolean
      origin: VersionOrigin
      schema: ResourceSchema | null
    }
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ storageKey: resource.storageKey })
        .from(resource)
        .where(eq(resource.id, resourceId))
        .limit(1)
        .for('update')
      if (locked?.storageKey !== live.storageKey) return false

      if (live.stale) {
        await tx
          .update(resource)
          .set({ hash: live.hash, size: live.size })
          .where(eq(resource.id, resourceId))
      }

      return insertVersionIfHeld(tx, claim, {
        resourceId,
        version: await nextVersionNumber(tx, resourceId),
        storageKey: live.storageKey,
        size: live.size,
        hash: live.hash,
        // How the bytes got here, which is what `origin` records — a fetch or
        // an upload published this object, and the migration only gives it a
        // number. Calling it a revert would put a claim in the history that
        // nothing supports: `restoredFrom` has to stay null here, because
        // repeated bytes mean no comparison says which version this content
        // came from.
        origin: live.origin,
        schema: live.schema,
      })
    })
  }

  /**
   * Propagate a purge into DuckLake (ADR-043 §5, layer 2).
   *
   * **Moves the contents only when the table is standing on the purged version**,
   * which is when they would otherwise still hold its rows. That is asked of the
   * recorded snapshots rather than of the pointer: layer 2 stands on the newest
   * version it took, which is not the live one as soon as a version the lake could
   * not take — too large, not tabular, in ii-b an unusable key — sits above it.
   * Both directions occur, so a middle version can be the top of layer 2 and a
   * live one can be below it.
   *
   * The table is then stood on layer 2's own restore target — **not the
   * pointer's** (spec §9.1, {@link lakeStandDown}) — and dropped only when no
   * version is left whose rows it can hold. A drop costs the contents alone; the
   * retained snapshots read through it (spec §9.1).
   *
   * **The only operation left that moves contents without publishing** (spec
   * §7.2). It goes through the ingest path and records nothing: the version it
   * lands on keeps the snapshot its own ingest wrote, and the landing snapshot is
   * named by no version row, which is the state §11-3 already keeps.
   *
   * Either way the snapshot has to be expired and its Parquet deleted, or the
   * rows remain readable straight from the catalog. That runs for every purge
   * of a version that reached the lake, which is why this is not confined to the
   * live one.
   *
   * Failures propagate: the version stays in `purging` and the worker retries,
   * rather than the purge completing while the version is still reachable
   * through layer 2. Reachability is what this closes — the bytes may stay
   * (ADR-043 §5).
   */
  private async purgeFromLake(
    resourceId: string,
    lake: LakeConfig | undefined,
    purgedSnapshot: number | null
  ): Promise<void> {
    // Never ingested: the lake holds nothing of this version, so there is
    // neither anything to stand down from nor anything to free. Opening a
    // session costs extension loads and a catalog ATTACH — not worth it to find
    // that out, and most resources are not tabular.
    if (!lake || purgedSnapshot === null) return
    const table = lakeTableName(resourceId)
    await withLakeSession(lake, async (session) => {
      await withLakeIngestLock(this.db, async (tx) => {
        // Read under the lock, like the ingest reads its base: a run committing
        // between the read and the move would have its snapshot stood off with
        // nothing left to queue it again.
        const down = await lakeStandDown(tx, session, resourceId, purgedSnapshot)
        // Those contents describe a version this purge does not touch. The
        // reclaim below still runs — another resource's purge may have left
        // snapshots behind when it failed partway.
        if (down.move === 'stays') return
        // Gone already — dropped by an earlier purge that had nowhere to stand,
        // or by a restore. There is nothing to move and nothing to make
        // unfetchable. Asked after the target, so a resource whose recorded ids
        // no longer resolve still fails rather than reading as one with nothing
        // to do.
        if (!(await lakeTableExists(session, table))) return
        if (down.move === 'drop') {
          await dropLakeTable(session, table)
          return
        }
        await restandLakeTable(session, { table, snapshot: down.snapshot })
      })
      // The row being purged is `purging`, which the reclaim's retained set
      // excludes along with `purged` — so its snapshot reads as unreferenced
      // without needing a special case.
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
    // **One version per resource, the oldest.** A resource can have several
    // outstanding at once — the conversion flips rows into the eligible set and
    // issues a version above them in the same pass (ADR-044 §4) — and the queue
    // is not ordered. Handed out together, whichever the worker takes first
    // wins: ingest a newer one and the older ones are overtaken, which the
    // ingest refuses for good, so they keep no snapshot and drop out of this
    // very query. Oldest first, and the next pass hands out the next.
    const result = await this.db.execute(sql`
      SELECT DISTINCT ON ("resourceId") * FROM (${pendingLakeIngestQuery()}) pending
      ORDER BY "resourceId", version
    `)
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

  /**
   * Queue the next version of one resource layer 2 has not loaded.
   *
   * **What keeps a backlog draining.** A sweep hands out one version per
   * resource (see {@link queuePendingLakeIngests}), so without this the rest
   * wait an hour each — long enough for ordinary content to arrive, take a
   * snapshot above them, and overtake the lot for good. Called when an ingest
   * finishes, it walks a resource's backlog in seconds instead.
   *
   * Self-terminating, and `handled` is what makes that true rather than nearly
   * true. An attempt usually leaves its version holding a snapshot or an empty
   * schema, either of which takes it out of the set — but one that interpreted
   * nothing records neither, and chaining would then hand the same version
   * straight back, forever. Excluded here, it waits for the sweep instead.
   *
   * @param handled - the version this attempt dealt with, whatever came of it.
   * @returns whether anything was queued.
   */
  async queueNextPendingLakeIngest(
    queue: QueueAdapter,
    resourceId: string,
    handled: number
  ): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT * FROM (${pendingLakeIngestQuery({ resourceId })}) pending
      WHERE version <> ${handled} ORDER BY version LIMIT 1
    `)
    const [next] = result.rows as unknown as PendingLakeIngest[]
    if (!next) return false
    await queue.enqueue(LAKE_INGEST_JOB_TYPE, { resourceId, version: next.version })
    return true
  }

  /** List a resource's versions, newest first. */
  async listByResource(resourceId: string): Promise<VersionView[]> {
    return this.readSnapshot(async (tx) => {
      const rows = await tx
        .select()
        .from(resourceVersion)
        .where(eq(resourceVersion.resourceId, resourceId))
        .orderBy(desc(resourceVersion.version))
      // The standing versions are in `rows` already, in the order this needs.
      const serving = {
        live: await this.liveVersionNumber(tx, resourceId),
        standing: rows.filter((r) => r.state === 'active').map((r) => r.version),
      }
      // Which sources are tombstones, read off the list rather than per row.
      const purgedVersions = new Set(rows.filter((r) => r.state === 'purged').map((r) => r.version))
      return rows.map((row) =>
        toView(row, serving, row.restoredFrom !== null && purgedVersions.has(row.restoredFrom))
      )
    })
  }

  /** Get a single version (tombstone view when purged). */
  async getVersion(resourceId: string, version: number): Promise<VersionView> {
    return this.readSnapshot(async (tx) => {
      const row = await this.getRow(tx, resourceId, version)
      return toView(
        row,
        await this.serving(tx, resourceId),
        await this.sourceIsPurged(tx, resourceId, row.restoredFrom)
      )
    })
  }

  /**
   * Whether the version a revert re-published has since been purged.
   *
   * Its own read because the single-version paths hold one row: the list
   * answers it from the rows it already has.
   */
  private async sourceIsPurged(
    db: Database | Transaction,
    resourceId: string,
    restoredFrom: number | null
  ): Promise<boolean> {
    if (restoredFrom === null) return false
    const [row] = await db
      .select({ state: resourceVersion.state })
      .from(resourceVersion)
      .where(
        and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, restoredFrom))
      )
      .limit(1)
    return row?.state === 'purged'
  }

  /**
   * What the resource is standing on, and what it could stand on instead.
   *
   * For the paths that hold one row rather than the list: `standing` is read as
   * the two newest versions a restore may land on, which is all a fallback can
   * ever be — the newest that is not the row in hand.
   */
  private async serving(
    db: Database | Transaction,
    resourceId: string
  ): Promise<{ live: number | null; standing: number[] }> {
    const standing = await db
      .select({ version: resourceVersion.version })
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.state, 'active')))
      .orderBy(desc(resourceVersion.version))
      .limit(2)
    return {
      live: await this.liveVersionNumber(db, resourceId),
      standing: standing.map((r) => r.version),
    }
  }

  /**
   * Read the rows and the pointer as one snapshot.
   *
   * **A view has to answer from one moment.** The two halves — which versions
   * there are, and which of them is live — are separate statements, and a revert
   * committing between them yields a list from before it with a pointer from
   * after: the version it stepped off still reads `active`, so the screen names
   * it as where serving will land while the purge would land on the one below.
   * `repeatable read` is what makes both statements read the same instant;
   * `read only` says the transaction exists for that and nothing else.
   */
  private async readSnapshot<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(fn, { isolationLevel: 'repeatable read', accessMode: 'read only' })
  }

  /**
   * Which version the resource is serving, or null when no version owns the live
   * object — content uploaded but never versioned, or every version purged.
   *
   * The pointer's owner, which is the only thing that answers it: see
   * {@link VersionView.isLive}. Every non-purged state counts, `purging`
   * included — a purge in flight is still what is being served until it moves the
   * pointer, and this is exactly the read `executePurge` decides from.
   *
   * **Where no version owns the live object it is a guess, and the purge shares
   * it.** Rows from before a version owned its bytes leave the pointer named by
   * nobody, and {@link liveVersion} then falls back to the newest version whose
   * hash matches — which is not necessarily the one the content came from. It
   * is still the right answer to show, but only half of what the screen says
   * survives it: **what the purge will do** is right, since it acts on this
   * same answer, while **"this version is what is being served"** can land on
   * another version holding the same bytes.
   */
  private async liveVersionNumber(
    db: Database | Transaction,
    resourceId: string
  ): Promise<number | null> {
    const [row] = await db
      .select({ storageKey: resource.storageKey, hash: resource.hash })
      .from(resource)
      .where(eq(resource.id, resourceId))
      .limit(1)
    if (!row) return null
    return (await this.liveVersion(db, resourceId, row, SERVING_STATES)) ?? null
  }

  /**
   * Resolve the storage key for downloading a version's content.
   * Throws NotFoundError when the version is missing or purged (content gone).
   */
  async getDownloadTarget(
    resourceId: string,
    version: number
  ): Promise<{ storageKey: string; size: number | null }> {
    const row = await this.getRow(this.db, resourceId, version)
    if (row.state === 'purged') {
      throw new NotFoundError('Resource version', `${resourceId}/v${version}`)
    }
    return { storageKey: row.storageKey, size: row.size }
  }

  /**
   * Claim a version for purge: active → purging, recording who/why durably on
   * the row (ADR-028 pattern). Idempotent — a version already purging/purged is
   * returned unchanged and should not be re-enqueued.
   *
   * Every surviving version can be claimed, including one a revert moved off. A
   * revert destroys nothing: content from a file that should never have been
   * served outlives it as an ordinary version, and purging that version is the
   * rung above (ADR-044 §4). Refusing it would make the version most likely to
   * need destroying the one that cannot be.
   *
   * Returns { claimed } so the route knows whether to enqueue the worker job.
   */
  async claimPurge(
    resourceId: string,
    version: number,
    userId: string,
    reason: string
  ): Promise<{ claimed: boolean; view: VersionView }> {
    // Two steps on purpose. The claim is a write and takes only the row it
    // changes, so reading the rest of the resource inside it reads whatever
    // commits alongside — a revert moves the pointer and steps versions off
    // without touching this row, and its `FOR UPDATE` does not hold that back.
    // The view is therefore built afterwards, from one snapshot
    // ({@link readSnapshot}), which is the only way its halves agree; it includes
    // this claim, since that has committed by then.
    const claimed = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(resourceVersion)
        .where(
          and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, version))
        )
        .limit(1)
        .for('update')

      if (!row) throw new NotFoundError('Resource version', `${resourceId}/v${version}`)

      // Refused by what is already gone or going, not by what is `active`: a
      // row still saying `superseded` from before a revert published forward
      // (ADR-044 §4) holds content like any other, and is the version most
      // likely to be the one someone needs destroyed.
      if (row.state === 'purging' || row.state === 'purged') return false

      // One at a time per resource, refused by the partial unique index rather
      // than by looking first: a look and a write are two steps, and two claims
      // for different versions take different rows, so both would look before
      // either wrote. Refused rather than queued — a purge is a rare and
      // deliberate act, and "another version of this resource is being purged"
      // is something the person asking can act on.
      try {
        await tx
          .update(resourceVersion)
          .set({
            state: 'purging',
            purgedBy: userId,
            purgeReason: reason,
            updated: sql`NOW()`,
          })
          .where(eq(resourceVersion.id, row.id))
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

      return true
    })

    // Read back rather than returned from the write: the row this reports is the
    // one the claim left, and it has to be described by the same snapshot as the
    // rest of the resource.
    return { claimed, view: await this.getVersion(resourceId, version) }
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
    // them reachable and nothing to reclaim them. A purge cannot end with the
    // content still in the bucket. A refusal leaves the version in
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
      (await this.liveVersion(this.db, resourceId, pkgRow, SERVING_STATES)) === version

    // The object this version owns, destroyed before the pointer is moved off
    // it. A purge falls the safe way round: interrupted here, live names an
    // object that is gone — unservable — rather than one that is not.
    await deps.storage.delete(row.storageKey)

    let rolledBack = false
    if (isLive && pkgRow) {
      // Everything this purge owes about the content happens before the pointer
      // moves. The pointer is what `isLive` reads, so moving it is what hides
      // that any of it is still owed: a purge interrupted after came back
      // reading itself as a middle version and took the branch that does none of
      // it — leaving the preview, the search index and the lake's current
      // contents serving what the purge had just made unobtainable, under a row
      // that then said 'purged'. Done first, an interruption can only leave work
      // already finished.
      await this.discardDerivedArtifacts(resourceId, deps.storage)
      if (deps.search) await deps.search.deleteContent(resourceId)
      // Said on the row as well: the regeneration reads it to decide whether it
      // has anything to derive, and clearing the preview alone leaves that
      // answer resting on a side effect of another statement.
      await markContentUnindexed(this.db, { resourceId })
      await this.setPurgeRebuildPending(resourceId, true)

      // Then layer 2, still before the pointer moves. **Not hoisted above this
      // branch**, identical as the two calls are: the lake is the one step here
      // that can fail, and failing it before the preview and the search index are
      // gone leaves them serving content whose layer-1 object has already been
      // deleted — retrievable from the derivatives alone, for as long as the lake
      // stays down. Spec §9.1 orders it the same way, step 3 before step 4.
      await this.purgeFromLake(resourceId, deps.lake, row.ducklakeSnapshotId)

      // The pointer's own target, which it reads for itself: this row is already
      // out of the active set (`purging`), so it cannot restore itself, and
      // nothing left to stand on empties the resource. Layer 2 used to be handed
      // the same row to keep the two on one version — the lake left on a version
      // nothing pointed at was a version the next purge read as a middle one and
      // never took out. Layer 2 reads its own target now, whether or not the two
      // agree.
      rolledBack = (await this.restoreLiveFromVersions(this.db, resourceId, pkgRow)) !== null

      // The object the purged content was being served from, deleted now rather
      // than left to the sweep: cutting off a reader that already resolved that
      // key is the point.
      //
      // Unless it is the version file already deleted above: live standing on
      // the version being purged is exactly what `isLive` means now that the
      // pointer answers it (ADR-043 §1), so the two keys are the same one.
      if (pkgRow.storageKey && pkgRow.storageKey !== row.storageKey) {
        await deps.storage.delete(pkgRow.storageKey)
      }
    } else {
      // A middle version: what the resource serves is already free of it, and its
      // derivatives describe content this purge does not touch. Layer 2 need not
      // be — it stands on the newest version it took, which is this one whenever
      // nothing above it reached the lake — so the same call runs, and decides for
      // itself from the recorded snapshots (spec §9.1).
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
   * **It goes forward.** The destination's content is issued as a new version
   * rather than the versions above it being taken out of the running (ADR-044
   * §4). The history only grows, so "live is the highest surviving version"
   * needs no state to arrange it, and the content the resource steps off stays
   * an ordinary version — purgeable, downloadable, and reachable by naming it
   * again. What it costs is a version number and a copy of the bytes per
   * revert.
   *
   * @returns the destination and the version issued to carry it — see
   *   {@link RevertOutcome} — plus the {@link LadderOutcome} halves:
   *   `cleared: false` when the content was retracted but its derivatives
   *   outlived it, `queued: false` when the rebuild that puts them back never
   *   reached the queue. Either is repaired by {@link repairDerivatives}, never
   *   by reverting again.
   */
  async revertLiveContent(
    resourceId: string,
    target: { restoreTo: number | null; ifLiveRevision: string },
    deps: {
      storage: StorageAdapter
      search?: SearchAdapter
      queue: QueueAdapter
      logger?: Logger
    }
  ): Promise<RevertOutcome> {
    const log = deps.logger ?? createLogger({ name: 'api' })

    // Everything that can end in "do not proceed" is settled before the claim,
    // because taking it stops whatever is running (ADR-044 §4). A refusal that
    // waits until after has already cost a run its work.
    //
    // The destination has to be a version whose content still exists. Naming a
    // missing or purged one would otherwise move the pointer and then publish
    // nothing — or somebody else's bytes — and report success. **Any surviving
    // version qualifies, including one an earlier revert stepped off**: going
    // forward, "issue that content again" says exactly one thing, so there is
    // no redo to refuse (ADR-044 §4).
    //
    // Read again under the claim before anything is written: a purge takes the
    // row in its own transaction, so the destination can be claimed between
    // here and there.
    // Through `getRow` so the "which version" predicate and its not-found error
    // have one spelling. The key it reads is what the copy below is made from:
    // a version file never changes, so reading it here rather than again later
    // costs nothing and saves a round trip.
    let sourceKey: string | null = null
    if (target.restoreTo !== null) {
      const row = await this.getRow(this.db, resourceId, target.restoreTo)
      if (row.state === 'purged' || row.state === 'purging') {
        throw new ConflictError(
          `Version ${target.restoreTo} of ${resourceId} is ${row.state}; it cannot be restored`
        )
      }
      sourceKey = row.storageKey
    }

    // A resend can land while the rebuild its own first attempt queued is still
    // going, so this too is answered without taking the claim.
    const settled = await this.settledRevert(resourceId, target, deps, log)
    if (settled) return settled

    const { cancelled, published, cleared } = await withClaimFromRun(
      this.db,
      resourceId,
      'revert',
      async (claim, cancelled) => {
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

        const published =
          target.restoreTo === null
            ? await this.db.transaction((tx) =>
                this.clearLiveContent(tx, resourceId, current, claim)
              )
            : await this.publishVersionContent(
                resourceId,
                claim,
                { version: target.restoreTo, storageKey: sourceKey! },
                current,
                deps.storage
              )

        // The retraction has happened: the pointer names the published content.
        // Layer 2 is not moved from here — the version just issued is
        // outstanding work for the Lake step like any other, and following the
        // pointer by hand would be the whole-table rewrite ii-b's write path
        // exists to avoid (spec §7.2).
        const cleared = await this.discardRetracted(resourceId, deps, log)

        return { cancelled, published, cleared }
      },
      // Refused inside the takeover statement rather than after it: told no
      // here, this call has already stopped whatever was running.
      target.ifLiveRevision
    )

    // Rebuild the derivatives from the published content, once the claim is
    // back: enqueued inside it, the run that picks the job up finds the
    // resource held and puts itself back on the queue for another 30 seconds.
    //
    // The Version step's change gate compares against the highest active
    // version, which is now the one this just published — same bytes, same
    // format — so it matches and no second version is filed for the same
    // content. Null rather than false when the resource was emptied: there is
    // no content for a run to rebuild from, so nothing was owed.
    const queued = published ? await this.queueRebuild(resourceId, deps, log) : null

    return {
      cancelled,
      restored: target.restoreTo,
      published,
      cleared,
      queued,
    }
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
      this.db,
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
   *
   * **Settled is asked of the content, not of the version number.** A revert
   * publishes the destination's bytes as a new version (ADR-044 §4), so live
   * stands on that new version and never on the one that was named — asked by
   * number, a resend would always find work to do, take the claim, and then be
   * refused over a generation its own first attempt moved. The bytes and the
   * format are what `restoreTo` asked for, and comparing those is the same
   * comparison the version gate makes: published again, they would create no
   * version, because there is nothing about the content left to record.
   *
   * That also answers settled for a resend naming a *different* version holding
   * the same bytes, which is right rather than merely tolerable — repeated
   * content is normal (ADR-046 §3), and what was asked for is what is served.
   */
  private async settledRevert(
    resourceId: string,
    target: { restoreTo: number | null },
    deps: {
      storage: StorageAdapter
      search?: SearchAdapter
      queue: QueueAdapter
    },
    log: Logger
  ): Promise<RevertOutcome | null> {
    const [current] = await this.db
      .select({
        storageKey: resource.storageKey,
        hash: resource.hash,
        format: resource.format,
        // The reading live is served under, of which the key is a part (spec
        // §6.4). A destination differing only in its key is a revert with work
        // to do, and comparing without it answers "already there" while the
        // interpretation stays where the retraction left it.
        columnSettings: resource.columnSettings,
        revision: resource.contentRevision,
      })
      .from(resource)
      .where(eq(resource.id, resourceId))
      .limit(1)
    if (!current) return null
    const live = { ...current, keyColumns: primaryKeyOf(current.columnSettings) }

    const settled =
      target.restoreTo === null
        ? current.storageKey === null
        : current.storageKey !== null &&
          (await this.liveIsVersionContent(resourceId, target.restoreTo, live)) &&
          // The second half of "already at the destination", and not implied by
          // the first. Content repeats (ADR-046 §3), so live can hold exactly
          // the destination's bytes while standing on **another version's
          // object** — and if that version is being purged, the object is about
          // to be destroyed under it. Answering settled there leaves the
          // resource pointing at content that will be gone, with the revert
          // that would have moved it off already told there was nothing to do.
          !(await objectOwnerIsPurging(this.db, current.storageKey))
    if (!settled) return null
    if (current.storageKey !== null) {
      // Settled, but "the content is in the right place" does not say the
      // derivatives were rebuilt: the attempt that moved it may have failed to
      // queue that, and then died before saying so. Queue it again — a rebuild
      // repeated over content already there costs a pass, and repairs a preview
      // and index that never came back.
      return {
        cancelled: false,
        restored: target.restoreTo,
        // Null rather than a number: nothing was published this time, and the
        // version an earlier attempt published is not this call's to report —
        // it may not even be the newest by now.
        published: null,
        // Nothing left to clear — the attempt that moved the content took the
        // derivatives with it, which is why this one is settled at all. Layer 2
        // included: what that attempt published is an outstanding version, and
        // the sweep queues it whether or not its own Lake step ran (spec §7.2).
        cleared: null,
        queued: await this.queueRebuild(resourceId, deps, log),
      }
    }

    const cleaned = await this.clearEmptied(resourceId, current.revision, deps, log)
    // Filled up in between: no longer settled, and the caller's generation is
    // stale with it. The path below is where that is answered.
    if (cleaned === null) return null
    return { cancelled: false, restored: null, published: null, cleared: cleaned, queued: null }
  }

  /**
   * Settle what a person decided about this resource's columns, from here on
   * (spec §6.2 / §6.4).
   *
   * **The whole settled layer, one apply.** ii-c adds settled types to the same
   * object, and §6.5's rule is that one confirm is one version and one copy of
   * the bytes — so the unit is the settings, not a field, and the rule lives
   * here rather than in the shape of a route. Written as a whole object for the
   * same reason: a partial write would leave a field standing that the caller
   * meant to clear.
   *
   * **Here rather than with the resource's other writes**, because what it
   * settles is the reading a version freezes, and it answers against the live
   * version's own record.
   *
   * **The setting, not the version.** What this writes applies to versions
   * created after it; the version that carries it is made by the run queued
   * below, where the create gate compares the setting against what the highest
   * active version froze (`version-gate`). Issuing one here would put a second
   * creator of ordinary versions beside the gate, and the useful end of the
   * change — that version interpreted and loaded into layer 2 under the new key
   * — is the worker's either way.
   *
   * **A rebuild, not an ordinary run.** The bytes must not move: a key change is
   * the same content read another way, and a run that re-fetched an external URL
   * would file whatever it serves now under the new key, with the boundary
   * between the two changes lost (ADR-044 §4). A whole run rather than a
   * lake-only pass because layer 2 has nothing to load until the version exists
   * and only the gate creates one — the preview and the search document are
   * rebuilt identically on the way past, which is what that costs.
   *
   * **What is written and what is queued are decided separately.** The write is
   * owed when the stored settings differ; the run is owed when the highest
   * active version does not already carry them. Folding the two would make a
   * failed enqueue unrecoverable — the setting is saved, so a resend finds
   * nothing to write and queues nothing, and no sweep looks for a resource whose
   * setting and newest version disagree. Asked this way, a resend after a queue
   * that was down is the repair, which is the shape a settled revert already
   * takes (it re-queues the rebuild it cannot prove ran).
   *
   * **A resource with no versions is owed nothing**: the first version it gets
   * freezes whatever the setting says at its own creation, so there is no run to
   * queue and repeated calls do not pile up jobs that can only fail.
   *
   * **Nor is one already on its way**, while there is reason to believe it is
   * still coming ({@link runPending}). A run reads the setting when it reaches
   * its Version step, so a resend made while the first run is still queued would
   * only add a job that arrives to find the version already made. **Only when
   * the setting did not change**: one that just did cannot be carried by a run
   * that may already be past its Version step.
   *
   * @returns the settings as stored, and whether a run is on its way — `null`
   *   when none was needed. Never whether a version was created: that is the
   *   gate's answer, minutes later.
   */
  async setColumnSettings(
    resourceId: string,
    settings: ColumnSettings,
    deps: { queue: QueueAdapter; logger?: Logger }
  ): Promise<{ primaryKey: string[] | null; queued: boolean | null }> {
    const log = deps.logger ?? createLogger({ name: 'api' })
    // "No key" has one spelling from here on (spec §6.2).
    const key = primaryKeyOf(settings)

    const [current] = await this.db
      .select({ settings: resource.columnSettings })
      .from(resource)
      .where(eq(resource.id, resourceId))
      .limit(1)
    if (!current) throw new NotFoundError('Resource', resourceId)

    if (key) await this.assertColumnsExist(resourceId, key)

    const settled = sameKeyColumns(primaryKeyOf(current.settings), key)
    if (!settled) {
      await this.db
        .update(resource)
        .set({
          columnSettings: key ? { primaryKey: key as [string, ...string[]] } : {},
          // A person's edit, so it moves the resource's own timestamp — that is
          // what the screens and the API mean by "updated".
          updated: sql`NOW()`,
        })
        .where(eq(resource.id, resourceId))
    }

    const latest = await this.newestActiveVersion(this.db, resourceId)
    const carried = latest === null || sameKeyColumns(latest.lakeKeyColumns, key)
    if (carried || (settled && (await this.runPending(resourceId)))) {
      return { primaryKey: key, queued: null }
    }
    return { primaryKey: key, queued: await this.queueRebuild(resourceId, deps, log) }
  }

  /**
   * Whether a run is on its way, or in the middle of one — and recently enough
   * that it is still worth waiting for.
   *
   * **`queued` alone is not evidence that a job exists.** `PipelineService.enqueue`
   * writes the row first and sends the message second, so a process that dies in
   * between leaves the row saying `queued` with nothing in the queue. Trusted
   * bare, that row would suppress every later resend and the settings a version
   * never carried would have no way back — the endpoint's whole recovery story
   * rests on a resend being able to queue again.
   *
   * So the row also has to be recent. The window is the one the claim uses, for
   * the same reason it has one value: after it, everything else in the system
   * considers a run dead, and this cannot be the one place that goes on waiting.
   *
   * **The two states are dated differently, because they leave different marks.**
   * A run in flight is judged by {@link staleClaim}, the expression every other
   * claimer asks — its steps date it, and `updated` does not move when one
   * starts, so a long run whose current step is minutes old would otherwise read
   * as dead here alone and have a second rebuild queued behind it (which
   * `enqueue` would also put the row back to `queued` for, while it is still
   * running).
   *
   * A queued job has neither a claim nor a step to date it from, so the
   * enqueue's own write to `updated` is the only mark there is — the column the
   * schema warns against for judging *claim* liveness. What that borrows is
   * bounded: another writer refreshing the row delays a recovery by the window,
   * where mis-judging a claim would extend a dead run for ever.
   */
  private async runPending(resourceId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: resourcePipeline.id })
      .from(resourcePipeline)
      .where(
        and(
          eq(resourcePipeline.resourceId, resourceId),
          // In the predicate rather than the projection, which is where a
          // correlated subquery keeps its table qualification (CLAUDE.md).
          sql`CASE ${resourcePipeline.status}
                WHEN 'queued' THEN ${resourcePipeline.updated} >
                  NOW() - ${`${CLAIM_STALE_AFTER_MS} milliseconds`}::interval
                WHEN 'processing' THEN NOT (${staleClaim(CLAIM_STALE_AFTER_MS, sql`resource_pipeline`)})
                ELSE false
              END`
        )
      )
      .limit(1)
    return row !== undefined
  }

  /**
   * Refuse a key naming columns the resource does not have.
   *
   * **Against the live version's frozen schema**, not the resource's cached
   * interpretation: that one is the worker's to rewrite, and a run whose
   * Interpret failed leaves it describing the content before this one
   * (`schemaDescribesLiveContent` exists for that reason). A key picked off a
   * stale list would pass here and reach the ingest as `key-missing` — the exact
   * outcome this check is meant to pre-empt. It also answers for a resource that
   * has versions but no pipeline row, which layer 1's backfill leaves behind.
   *
   * A courtesy, not a guarantee: columns move under keys that were valid when
   * they were set, and recording that is `lake_ingest_reason`'s job (spec §6.6).
   */
  private async assertColumnsExist(resourceId: string, key: string[]): Promise<void> {
    const version = await this.liveVersionNumber(this.db, resourceId)
    const schema =
      version === null ? null : (await this.getRow(this.db, resourceId, version)).schema
    if (!schema) {
      throw new ValidationError(
        `Resource ${resourceId} has no interpreted columns to identify rows by`
      )
    }
    const columns = new Set(schema.columns.map((column) => column.name))
    const missing = key.filter((column) => !columns.has(column))
    if (missing.length > 0) {
      throw new ValidationError(`No such column in this resource: ${missing.join(', ')}`)
    }
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
      // Layer 2 is not this rung's to put right, and there is nothing here for it
      // to do: the only operations that move the table are its own ingests and a
      // purge standing it down (spec §7.2). `null` rather than `false` — nothing
      // is owed, so the screen reads this as done.
      //
      // No claim taken either: the rebuild is queued outside one, or the run that
      // picks the job up finds the resource held and puts itself back on the
      // queue for another 30 seconds.
      return { queued: await this.queueRebuild(resourceId, deps, log), cleared: null }
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
   * Whether what the resource serves is already the content of `version`.
   *
   * Answered through {@link sameVersionIdentity}, the definition the pipeline's
   * create gate uses (ADR-046 §3). The two ask one question — is this content,
   * read this way, already what is recorded — and a second spelling here stops
   * agreeing the day the identity gains a field. In ii-b that field is the
   * primary key, and the disagreement would be a destination differing only in
   * its key answered as already restored, with its interpretation never coming
   * back and nothing failing.
   *
   * A purged version answers false whatever its row still says: the hash stays
   * on the tombstone, the content does not.
   */
  private async liveIsVersionContent(
    resourceId: string,
    version: number,
    live: VersionIdentity
  ): Promise<boolean> {
    const [row] = await this.db
      .select({
        hash: resourceVersion.hash,
        format: resourceVersion.format,
        keyColumns: resourceVersion.lakeKeyColumns,
        state: resourceVersion.state,
      })
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, version)))
      .limit(1)
    if (!row || row.state === 'purged') return false
    return sameVersionIdentity(row, live)
  }

  /**
   * The version holding what is live now, if any version holds it.
   *
   * Where the live pointer is standing. The pointer names an object and a
   * version owns one (ADR-043 §1), so the answer is the version that owns the
   * live key — and only where nothing owns it is it the newest version sharing
   * the live hash. Content can repeat (ADR-046 §3), so hash alone would answer
   * yes for any version holding those bytes.
   *
   * **The fallback is not a legacy branch.** Fetch publishes a fresh key even
   * for content that did not change, and the gate then creates no version, so
   * an object nobody owns is the ordinary outcome of re-fetching an unchanged
   * URL (ADR-044 §4). It answers correctly there — no version was created
   * precisely because the content matched the latest active one, so the newest
   * match is that version. What defeats it is a row an old-style revert set
   * aside above live holding the same hash, which the conversion removes.
   *
   * `states` is the caller's, because the two ask it from different places. A
   * revert asks among active versions: it is looking for what to step off, and
   * a version it superseded on an earlier pass must not be found again or
   * repeated content would leave it stepping in place. A purge asks among
   * everything not yet purged, because the row it is asking about is its own
   * and has already left `active`.
   *
   * Undefined when no version holds the live content and no hash matches it —
   * a file uploaded but never created, or a creation the kill cut off. There is
   * nothing to step back from, and the newest version is the right place to
   * land.
   */
  private async liveVersion(
    db: Database | Transaction,
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
      const [owner] = await db
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

    // Nothing owns it: an unchanged re-fetch published a fresh key the gate
    // created no version for, so no version names what live names. Hash is all
    // there is to go on, and the newest match is the one stood on.
    if (!live.hash) return undefined
    const [row] = await db
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
   * **A purge's way of retracting content, and no longer a revert's** (ADR-043
   * §5). A purge destroys the object it steps off and cannot publish a version
   * carrying it forward — there would be nothing to carry — so it steps down,
   * where a revert issues the destination as a new version (ADR-044 §4).
   *
   * Restored through the same mover as every other writer (ADR-043), onto the
   * version's own object: nothing rewrites a version file, so there is nothing
   * to copy out first, and the move is the whole restore.
   *
   * Where it lands needs no bound from the caller: the version being purged has
   * already left the active set by the time this runs, marked `purging`, so
   * "the newest active version" is the one below it.
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

  /**
   * Issue a version's content as the newest version, and serve it (ADR-044 §4).
   *
   * The whole of a revert's write. The destination keeps its row untouched; a
   * copy of its bytes becomes a version of its own, and the pointer moves onto
   * that copy. Copied rather than shared because a version owns the object it
   * names (ADR-046 §3) — two rows on one key would leave a purge of either
   * taking the other's content.
   *
   * The copy is made before the transaction and stays outside it: its
   * write-ahead record is what reclaims the object when the rest does not
   * commit, and a rollback would take the record with it (ADR-045).
   *
   * Inside, the pointer moves before the row is inserted. The insert reads the
   * format off the resource, and the format belonging to this version is the
   * destination's — a version is those bytes under that label (ADR-046 §6), so
   * with the writes the other way round the new row would record whichever
   * label the retracted content was carrying.
   *
   * **`retracting` is what separates the two callers.** A revert is retracting
   * content: the resource stops being what it was and becomes the destination,
   * so its label and its interpretation move to the destination's along with
   * the bytes. The conversion (ADR-044 §4) is not — the destination already
   * owns the live object, so the served bytes do not change and nothing about
   * how the resource describes itself may either. Told it was a revert, it
   * relabels a resource the user has since renamed, and wipes the live
   * interpretation to match a destination row that has none (the vintage with
   * set-aside rows predates versions recording a schema), with no rebuild
   * queued to put it back.
   *
   * @returns the version number issued.
   * @throws ConflictError when the destination was claimed for purge, or the
   *   pointer moved, while this was running. Both leave the copy to the sweep.
   */
  private async publishVersionContent(
    resourceId: string,
    claim: ResourceClaim | null,
    destination: { version: number; storageKey: string },
    current: { packageId: string; storageKey: string | null; hash: string | null },
    storage: StorageAdapter,
    retracting: boolean = true
  ): Promise<number> {
    const versionKey = getStorageKey(current.packageId, resourceId, randomUUID())
    await copyObject(this.db, storage, destination.storageKey, versionKey)

    return this.db.transaction(async (tx) => {
      // Locked and read again: the pre-claim check is only good while nothing
      // can change the row, and claiming a purge takes no pipeline claim. A
      // destination claimed in between would have this publishing bytes someone
      // asked to have destroyed, under a number the purge does not recognise.
      const [row] = await tx
        .select()
        .from(resourceVersion)
        .where(
          and(
            eq(resourceVersion.resourceId, resourceId),
            eq(resourceVersion.version, destination.version)
          )
        )
        .limit(1)
        .for('update')
      if (!row || row.state === 'purged' || row.state === 'purging') {
        throw new ConflictError(
          `Version ${destination.version} of ${resourceId} is ${row?.state ?? 'gone'}; ` +
            `it cannot be restored`
        )
      }

      const version = await nextVersionNumber(tx, resourceId)

      const published = await publishLiveContent(tx, resourceId, {
        key: versionKey,
        previousKey: current.storageKey,
        hash: row.hash,
        size: row.size,
        previousHash: current.hash,
        // Omitted entirely when not retracting, which leaves the columns alone —
        // passing the resource's own values back would still mint a generation
        // for a label nobody changed.
        ...(retracting ? { format: row.format, keyColumns: row.lakeKeyColumns } : {}),
        claim,
      })
      if (!published) {
        throw new ConflictError(`Resource ${resourceId} changed while being restored; retry`)
      }

      const inserted = await insertVersionIfHeld(tx, claim, {
        resourceId,
        version,
        storageKey: versionKey,
        size: row.size!,
        hash: row.hash!,
        origin: 'revert',
        // Where this content came from, which nothing can work out later.
        restoredFrom: destination.version,
        // Carried across rather than left for the rebuild to work out again: a
        // version file never changes, so its interpretation cannot have, and
        // the copy is the same file. The rebuild would reach the same answer
        // minutes later and only if it completes. Guarded on the label it was
        // read under, which a retracting caller has just written and a
        // converting one has not.
        schema: row.schema,
        schemaFormat: row.format,
      })
      if (!inserted) {
        throw new ConflictError(`Resource ${resourceId} changed while being restored; retry`)
      }

      if (retracting) await this.adoptVersionInterpretation(tx, resourceId, row)
      return version
    })
  }

  /**
   * Leave the resource serving nothing — the two callers that retract content
   * with nothing to put in its place.
   *
   * A revert with no destination named reaches it in its own transaction and
   * under the claim; a purge of the only surviving version reaches it inside
   * the purge's own work. No version is issued either way: there is no content
   * to carry forward, and a version of nothing is not a thing the history can
   * hold.
   *
   * **The claim is the difference, and it belongs to the revert.** Its sibling
   * branch moves the pointer only while the claim is held, and this is the more
   * destructive of the two — a revert taken over mid-flight must not be the
   * thing that empties the resource. A purge has already claimed the resource
   * by other means (ADR-028) and passes none.
   *
   * **The revert's use of it is not covered by a test.** Losing the claim has
   * to happen between the revert taking it and this statement, and there is
   * nothing of ours in between to hang a trigger on.
   */
  private async clearLiveContent(
    db: Database | Transaction,
    resourceId: string,
    current: { storageKey: string | null; hash?: string | null },
    claim?: ResourceClaim | null
  ): Promise<null> {
    // Through the mover like every other pointer move: unconditional, this
    // would clear a pointer an upload had moved since (uploads take no claim,
    // ADR-044 §6) and leave the retracted object tracked by nothing.
    const emptied = await publishLiveContent(db, resourceId, {
      key: null,
      previousKey: current.storageKey,
      hash: null,
      size: null,
      previousHash: current.hash ?? null,
      claim,
    })
    if (!emptied) {
      throw new ConflictError(`Resource ${resourceId} changed while being emptied; retry`)
    }
    await this.adoptVersionInterpretation(db, resourceId, null)
    return null
  }

  private async restoreLiveFromVersions(
    db: Database | Transaction,
    resourceId: string,
    current: { storageKey: string | null; hash?: string | null }
  ): Promise<typeof resourceVersion.$inferSelect | null> {
    const prev = await this.newestActiveVersion(db, resourceId)

    if (!prev) return this.clearLiveContent(db, resourceId, current)

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
      // under a new number. The key is the same argument (spec §6.4).
      format: prev.format,
      keyColumns: prev.lakeKeyColumns,
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
   * suggestion path. A purge cannot end with the content still readable, which
   * is the whole of ADR-043 §5.
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

  private async getRow(db: Database | Transaction, resourceId: string, version: number) {
    const [row] = await db
      .select()
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, version)))
      .limit(1)
    if (!row) throw new NotFoundError('Resource version', `${resourceId}/v${version}`)
    return row
  }
}
