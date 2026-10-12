/**
 * A resource's own layer 2 catalog, as the database sees it (ADR-067).
 *
 * The catalog is a file in the bucket; what makes a write of it count is the
 * resource's pointer, `resource_pipeline.lake_catalog_key`, moving to the new
 * key. That move is one transaction with everything the write says about the
 * version rows, so a writer that dies anywhere before it leaves the rows and
 * the pointer as they were — an uploaded catalog nothing names, which its
 * reservation lets the sweep reclaim (ADR-045).
 *
 * No lock is taken: the writers of one resource's catalog are its claim's
 * holders (ADR-044), and the pointer's compare-and-set turns away one that
 * lost the claim, or found the catalog moved underneath it.
 */
import { and, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Database, Transaction } from '@kukan/db'
import { orphanedObject, resourcePipeline, resourceVersion } from '@kukan/db'
import type { IngestResult, LakeConfig, LakeObjectStore, LakeSession } from '@kukan/lake'
import {
  ingestParquetVersion,
  keyFault,
  lakeCatalogFileNames,
  lakeCatalogKey,
  lakeDataPrefix,
  lakeResourcePrefix,
  lakeTableName,
  parseLakeCatalogKey,
  withLakeCatalogDraft,
} from '@kukan/lake'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { JobQueue } from '@kukan/queue'
import {
  ConflictError,
  DROP_LAKE_TABLES_JOB_TYPE,
  keyColumnsOf,
  sharedKeyColumns,
} from '@kukan/shared'
import type { KeyFault, NoTableReason } from '@kukan/shared'
import { PARKED_UNTIL, reserveObject } from '../pipeline/storage-pointer'
import { stillHeld, touchResourceClaim, type ResourceClaim } from '../pipeline/pipeline-claim'

/** A version, and where its rows are read from. */
export interface LakeIngestRow {
  resourceId: string
  version: number
  /**
   * The interpreted table on local disk (ADR-046). The pipeline has one because
   * the ingest runs inside its interpretation; the retry because it interprets
   * the version again.
   */
  sourcePath: string
  /** The holder the load commits under (ADR-044): a run, or the retry's job */
  claim?: ResourceClaim | null
}

/** What a resource catalog's writer needs besides the database. */
export interface LakeCatalogDeps {
  lake: LakeConfig
  store: LakeObjectStore
}

/** The bucket as the clearing of a resource's layer 2 leftovers reaches it. */
export type LakeLeftoverStorage = Pick<StorageAdapter, 'list' | 'deleteMany'>

/** The resource's current catalog, or null when it has none. */
export async function currentLakeCatalog(
  db: Pick<Database | Transaction, 'select'>,
  resourceId: string
): Promise<string | null> {
  const [row] = await db
    .select({ key: resourcePipeline.lakeCatalogKey })
    .from(resourcePipeline)
    .where(eq(resourcePipeline.resourceId, resourceId))
    .limit(1)
  return row?.key ?? null
}

/**
 * A version a rebuild could not load: its key no longer identifies its rows,
 * it is no longer a table, or reading it failed.
 */
export type LakeRefusal =
  | { version: number; keyFault: KeyFault }
  | { version: number; noTable: NoTableReason }
  | { version: number; ingestFailed: true }

/** A catalog uploaded under a new key, and what it says about the version rows. */
export interface LakeCatalogCommit {
  resourceId: string
  /** The key the writer started from; the pointer must still name it */
  from: string | null
  /** The uploaded catalog, or null for a resource left with none */
  to: string | null
  /** Snapshots to record, by version */
  snapshots: { version: number; snapshotId: number }[]
  /**
   * The catalog was built afresh (a rebuild): every version's snapshot is
   * cleared first, so one not in `snapshots` — the purged one, one that no
   * longer loads — names nothing in the new catalog.
   */
  rebuilt?: boolean
  /** Versions a rebuild could not load, and why — recorded so the sweep does not offer them again */
  refused?: LakeRefusal[]
  claim?: ResourceClaim | null
}

/**
 * Make an uploaded catalog the resource's: record the snapshots, move the
 * pointer from `from` to `to`, park `from` for the sweep and release `to`'s
 * reservation — one transaction, or none of it.
 *
 * Throws a {@link ConflictError} when the pointer no longer names `from`, or
 * the claim was lost: something else wrote this resource's catalog since, and
 * what was uploaded is built on a catalog that is not current. Its
 * reservation stays, so the sweep reclaims it.
 */
export async function commitLakeCatalog(
  db: Database | Transaction,
  commit: LakeCatalogCommit
): Promise<void> {
  await db.transaction(async (tx) => {
    const moved = await tx
      .update(resourcePipeline)
      .set({ lakeCatalogKey: commit.to, updated: sql`NOW()` })
      .where(
        and(
          eq(resourcePipeline.resourceId, commit.resourceId),
          sql`${resourcePipeline.lakeCatalogKey} IS NOT DISTINCT FROM ${commit.from}`,
          stillHeld(commit.claim)
        )
      )
      .returning({ id: resourcePipeline.id })
    if (moved.length === 0) {
      throw new ConflictError(
        `Layer 2 catalog of resource ${commit.resourceId} moved while being written; retry`
      )
    }
    if (commit.rebuilt) {
      await tx
        .update(resourceVersion)
        .set({ lakeSnapshotId: null })
        .where(eq(resourceVersion.resourceId, commit.resourceId))
      // A version on its way out is out of every catalog now. Its shared number
      // goes with this commit, not with the purge's tombstone: a purge retried
      // after a failed cleanup must find nothing left to rebuild (ADR-067 §4).
      await tx
        .update(resourceVersion)
        .set({ ducklakeSnapshotId: null })
        .where(
          and(
            eq(resourceVersion.resourceId, commit.resourceId),
            inArray(resourceVersion.state, ['purging', 'purged'])
          )
        )
    }
    for (const refusal of commit.refused ?? []) {
      const { version } = refusal
      await tx
        .update(resourceVersion)
        .set(
          'keyFault' in refusal
            ? { lakeIngestReason: refusal.keyFault }
            : 'noTable' in refusal
              ? { noTableReason: refusal.noTable }
              : { lakeIngestReason: 'ingest-failed' as const }
        )
        .where(
          and(
            eq(resourceVersion.resourceId, commit.resourceId),
            eq(resourceVersion.version, version)
          )
        )
    }
    for (const { version, snapshotId } of commit.snapshots) {
      await tx
        .update(resourceVersion)
        .set({ lakeSnapshotId: snapshotId })
        .where(
          and(
            eq(resourceVersion.resourceId, commit.resourceId),
            eq(resourceVersion.version, version)
          )
        )
    }
    if (commit.from) {
      await tx
        .insert(orphanedObject)
        .values({ key: commit.from, expiresAt: PARKED_UNTIL })
        .onConflictDoNothing()
    }
    if (commit.to) {
      await tx.delete(orphanedObject).where(eq(orphanedObject.key, commit.to))
    }
  })
}

/**
 * The version whose rows the resource's catalog holds — the one loaded last,
 * which is the highest recorded snapshot since every load commits above
 * everything recorded. `purging` because a version claimed for purge still
 * names its snapshot until the purge's rebuild commits, so it cannot say what
 * the contents are identified by.
 */
async function catalogHead(
  db: Pick<Database | Transaction, 'select'>,
  resourceId: string
): Promise<{ keyColumns: string[] | null; purging: boolean } | null> {
  const [head] = await db
    .select({ keyColumns: resourceVersion.lakeKeyColumns, state: resourceVersion.state })
    .from(resourceVersion)
    .where(
      and(eq(resourceVersion.resourceId, resourceId), isNotNull(resourceVersion.lakeSnapshotId))
    )
    .orderBy(desc(resourceVersion.lakeSnapshotId))
    .limit(1)
  return head ? { keyColumns: head.keyColumns, purging: head.state === 'purging' } : null
}

/**
 * Load one version's table into a catalog being written: refuse it when its
 * frozen key does not identify its rows, else load it under the key it shares
 * with what the table holds (`headKey`, undefined for an empty table) — what an
 * ingest and a rebuild both do with each version.
 */
export async function loadLakeVersion(
  session: LakeSession,
  opts: {
    resourceId: string
    parquetPath: string
    keyColumns: string[] | null
    headKey: string[] | null | undefined
  }
): Promise<{ fault: KeyFault } | IngestResult> {
  const { keyColumns, headKey } = opts
  if (keyColumns) {
    const fault = await keyFault(session, { parquetUrl: opts.parquetPath, keys: keyColumns })
    if (fault) return { fault }
  }
  return ingestParquetVersion(session, {
    table: lakeTableName(opts.resourceId),
    parquetUrl: opts.parquetPath,
    key: keyColumns && headKey !== undefined ? sharedKeyColumns(headKey, keyColumns) : null,
  })
}

/** An ingest into a resource's catalog, as its caller needs to know it. */
export interface ResourceIngestResult extends IngestResult {
  /**
   * The load committed, but what earlier attempts left could not be cleared:
   * the caller queues the clearing (`queueLakeRebuild`), which the queue
   * retries
   */
  uncleared?: true
}

/**
 * Load one version into its resource's catalog (ADR-067 §2).
 *
 * Returns null, writing nothing, when the version already has
 * a snapshot, a newer one is already in, or its key cannot identify its rows —
 * which is recorded on the version.
 */
export async function ingestVersionIntoResourceCatalog(
  db: Database,
  deps: LakeCatalogDeps & { storage: LakeLeftoverStorage },
  row: LakeIngestRow
): Promise<ResourceIngestResult | null> {
  const [pending] = await db
    .select({
      snapshot: resourceVersion.lakeSnapshotId,
      keyColumns: resourceVersion.lakeKeyColumns,
    })
    .from(resourceVersion)
    .where(
      and(
        eq(resourceVersion.resourceId, row.resourceId),
        eq(resourceVersion.version, row.version),
        eq(resourceVersion.state, 'active')
      )
    )
    .limit(1)
  if (!pending || pending.snapshot !== null) return null

  const [newer] = await db
    .select({ version: resourceVersion.version })
    .from(resourceVersion)
    .where(
      and(
        eq(resourceVersion.resourceId, row.resourceId),
        gt(resourceVersion.version, row.version),
        eq(resourceVersion.state, 'active'),
        isNotNull(resourceVersion.lakeSnapshotId)
      )
    )
    .limit(1)
  if (newer) return null

  const from = await currentLakeCatalog(db, row.resourceId)
  return withLakeCatalogDraft(
    deps.lake,
    deps.store,
    { resourceId: row.resourceId, from },
    async (draft) => {
      const head = await catalogHead(db, row.resourceId)
      // What `from` reads, for clearing what this attempt writes if it never
      // commits: the leftovers of the last attempt of a version that keeps
      // failing would otherwise wait for a write that may never come
      const before = await lakeCatalogFileNames(draft.session)
      let result: IngestResult
      let to: string
      let files: string[]
      try {
        const loaded = await loadLakeVersion(draft.session, {
          resourceId: row.resourceId,
          parquetPath: row.sourcePath,
          keyColumns: keyColumnsOf(pending.keyColumns),
          headKey: head && !head.purging ? head.keyColumns : undefined,
        })
        if ('fault' in loaded) {
          await db
            .update(resourceVersion)
            .set({ lakeIngestReason: loaded.fault })
            .where(
              and(
                eq(resourceVersion.resourceId, row.resourceId),
                eq(resourceVersion.version, row.version),
                // Written once and never cleared, it takes the version out of
                // the sweep for good — so not by a run that has been stopped.
                stillHeld(row.claim)
              )
            )
          return null
        }
        result = loaded
        to = lakeCatalogKey(row.resourceId, draft.generation)
        // Read before the publish detaches it
        files = await lakeCatalogFileNames(draft.session)
        await reserveObject(db, to)
        await draft.publish(to)
        await commitLakeCatalog(db, {
          resourceId: row.resourceId,
          from,
          to,
          snapshots: [{ version: row.version, snapshotId: result.snapshotId }],
          claim: row.claim,
        })
      } catch (err) {
        // Turned away, as a whole, once the pointer is not `from`. Failing
        // too, it is retried by the job the caller queues on a failed ingest
        // (`rebuild-lake-catalog`, which clears when there is nothing to rebuild).
        await clearLakeLeftovers(
          db,
          deps.storage,
          row.resourceId,
          row.claim,
          from ? { catalog: from, files: before } : undefined
        ).catch(() => {})
        throw err
      }
      // What attempts that never committed left behind, cleared by the next
      // write that does (ADR-067 §2). Not this ingest's failure, which has
      // committed: said so instead, for the caller to queue the clearing.
      const cleared = await clearLakeLeftovers(db, deps.storage, row.resourceId, row.claim, {
        catalog: to,
        files,
      }).then(
        () => true,
        () => false
      )
      return cleared ? result : { ...result, uncleared: true }
    }
  )
}

/**
 * Delete what is under the resource's layer 2 prefix and no catalog of its
 * will read: every generation but the one its pointer names — all of them
 * when there is none — and, given the current catalog's `files`, a data file
 * of that generation the catalog does not read. What a rebuild replaced, and
 * what an attempt that died before its commit left behind: a Parquet written
 * and never committed, a generation a rebuild started. Idempotent, so a purge
 * runs it on every attempt (ADR-067 §4), and an ingest after every commit.
 *
 * Catalog objects of the current generation are left to the ledger
 * (ADR-045): the one uploaded and not committed is reserved, the ones a
 * commit replaced are parked for their readers.
 *
 * **What to keep is read from the pointer, not from the caller,** and asked
 * again once the listing is in: a holder that lost its claim part-way would
 * otherwise delete the generation the next holder just committed. With a
 * claim, it is extended before the pointer is read — so no one else can take
 * it over while this runs — and checked again with the pointer before
 * anything is deleted. Either one moving turns the whole deletion away, as
 * does a pointer that names another catalog than the one `files` came from.
 */
export async function clearLakeLeftovers(
  db: Database,
  storage: LakeLeftoverStorage,
  resourceId: string,
  claim?: ResourceClaim | null,
  current?: { catalog: string; files: string[] }
): Promise<number> {
  if (claim) await touchResourceClaim(db, claim)
  const pointer = await currentLakeCatalog(db, resourceId)
  if (current && current.catalog !== pointer) {
    throw new ConflictError(`Layer 2 catalog of resource ${resourceId} moved before its clearing`)
  }
  const prefix = lakeResourcePrefix(resourceId)
  const generation = pointer ? parseLakeCatalogKey(pointer)!.generation : null
  const keep = generation ? `${prefix}${generation}/` : null
  const data = generation ? lakeDataPrefix(resourceId, generation) : null
  const read = current ? new Set(current.files) : null
  const leftover = (key: string) =>
    !keep ||
    !key.startsWith(keep) ||
    (read !== null && key.startsWith(data!) && !read.has(key.split('/').pop()!))

  const doomed = (await listLakeKeys(storage, prefix)).filter(leftover)
  if (doomed.length === 0) return 0

  if (claim) await touchResourceClaim(db, claim)
  if ((await currentLakeCatalog(db, resourceId)) !== pointer) {
    throw new ConflictError(
      `Layer 2 catalog of resource ${resourceId} moved while its leftovers were listed; retry`
    )
  }
  return deleteAllLakeKeys(storage, doomed, `resource ${resourceId}'s layer 2`)
}

/**
 * Delete the whole of these resources' layer 2 — every object under each one's
 * prefix (ADR-067 §4): what a package or organization purge does to it. For
 * resources whose rows are going or gone, so no writer is left to race; a
 * catalog object it deletes was parked or reserved, which the sweep then finds
 * gone.
 */
export async function deleteResourceLakes(
  storage: LakeLeftoverStorage,
  resourceIds: string[]
): Promise<number> {
  let deleted = 0
  // A few at a time: an organization's resources run to hundreds, held under
  // their claims meanwhile, and most have nothing under their prefix
  for (let i = 0; i < resourceIds.length; i += RESOURCE_LAKE_DELETE_CONCURRENCY) {
    const chunk = resourceIds.slice(i, i + RESOURCE_LAKE_DELETE_CONCURRENCY)
    const counts = await Promise.all(
      chunk.map(async (resourceId) =>
        deleteAllLakeKeys(
          storage,
          await listLakeKeys(storage, lakeResourcePrefix(resourceId)),
          `resource ${resourceId}'s layer 2`
        )
      )
    )
    deleted += counts.reduce((a, b) => a + b, 0)
  }
  return deleted
}

const RESOURCE_LAKE_DELETE_CONCURRENCY = 8

/** Every key under `prefix`, across the listing's pages. */
export async function listLakeKeys(
  storage: Pick<StorageAdapter, 'list'>,
  prefix: string
): Promise<string[]> {
  const keys: string[] = []
  let token: string | undefined
  do {
    const page = await storage.list(prefix, token)
    keys.push(...page.objects.map((o) => o.key))
    token = page.nextToken
  } while (token)
  return keys
}

/** Delete `keys`, throwing unless every one went; `what` they are names them in the error. */
export async function deleteAllLakeKeys(
  storage: Pick<StorageAdapter, 'deleteMany'>,
  keys: string[],
  what: string
): Promise<number> {
  if (keys.length === 0) return 0
  const deleted = await storage.deleteMany(keys)
  if (deleted.length < keys.length) {
    throw new Error(`Deleted ${deleted.length} of ${keys.length} objects of ${what}`)
  }
  return deleted.length
}

/**
 * Queue {@link deleteResourceLakes} in `tx`, the transaction that deletes the
 * resources' rows: the job exists exactly when the deletion does. For a purge
 * run in the web, which leaves the bucket work to the worker.
 */
export async function queueResourceLakesDeletion(
  queue: JobQueue,
  tx: Transaction,
  resourceIds: string[]
): Promise<void> {
  if (resourceIds.length === 0) return
  await queue.enqueue(DROP_LAKE_TABLES_JOB_TYPE, { resourceIds }, { tx })
}
