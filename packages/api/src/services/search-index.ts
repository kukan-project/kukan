/**
 * Search index helpers.
 * - indexPackageMetadata: single-record upsert for package CUD operations
 * - settleResourceWrites / syncDueResourceDocs: resource documents, after an edit
 *   and after a marked write
 * - rebuildMetadataIndex: batch rebuild of all packages + resources
 */

import { eq, and, asc, gt, inArray, isNotNull, notInArray, sql, type SQL } from 'drizzle-orm'
import {
  isLockTimeout,
  type Database,
  type Transaction,
  packageTable,
  resource,
  organization,
  group,
  packageGroup,
  packageTag,
  tag,
} from '@kukan/db'
import {
  BulkIndexError,
  type SearchAdapter,
  type DatasetDoc,
  type ResourceDoc,
} from '@kukan/search-adapter'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'
import { SYNC_RESOURCE_DOC_JOB_TYPE, isUuid, type Logger } from '@kukan/shared'
import { ResourceService, resourceDocColumns } from './resource-service'
import { PipelineService } from './pipeline-service'
import { enqueueResourceEmbedsIfDue } from './resource-embedding'
import {
  RESOURCE_DOC_SYNC_LOCK,
  tryLockInTransaction,
  withGlobalAdvisoryLock,
} from './advisory-lock'

/** The adapters every package-metadata sync needs — a structural subset of the
 *  route context vars, so routes can pass `c.var` directly. */
export interface PackageSyncDeps {
  search: SearchAdapter
  queue: QueueAdapter
  ai: AIAdapter
  logger: Logger
}

/**
 * Sync one package after a metadata change: upsert its search doc and ask for
 * the vectors the change marked. Always use this from routes (rather than
 * calling indexPackageMetadata directly) so a new call site cannot forget the
 * embed half of the pair. Non-active packages (drafts, ADR-039) are skipped
 * entirely, so callers can invoke unconditionally.
 */
export async function syncPackageMetadata(
  db: Database,
  deps: PackageSyncDeps,
  packageId: string
): Promise<void> {
  const indexed = await indexPackageMetadata(db, deps.search, packageId)
  if (indexed) await enqueueResourceEmbedsIfDue(db, deps, { packageId })
}

/**
 * Rebuild everything a package has in the search index: its own doc and
 * embedding, its resources' docs, and — via the pipeline, the only thing that
 * can — the resource contents.
 *
 * For the two transitions that make a package searchable at once: publishing a
 * draft, whose resources the Index step deliberately skipped (ADR-039/ADR-040),
 * and restoring a soft-deleted one, whose children `deletePackage` took with it.
 *
 * `fromStoredContent` runs the pipeline over the object each resource already
 * holds instead of fetching its URL again (ADR-044 §4). Restore uses it: putting
 * a dataset back must not republish whatever the source serves now — least of
 * all when it comes back private precisely to be reviewed first. Publishing a
 * draft is the opposite case: its resources are being fetched as they go up.
 *
 * The resources' documents go through the sync's lock like every other write
 * of them: publish and restore mark the rows in the transaction that makes the
 * dataset live, and anything the write cannot settle is left to the job. The
 * rest fails the request: publish and restore are both idempotent, so
 * re-sending the same request retries the whole sync.
 */
export async function rebuildPackageSearch(
  db: Database,
  deps: PackageSyncDeps,
  packageId: string,
  opts: { fromStoredContent?: boolean } = {}
): Promise<void> {
  const resources = await new ResourceService(db).listForSearchRebuild(packageId)
  const pipeline = new PipelineService(db, deps.queue)
  // Resources with no object have nothing to rebuild from, and no content in
  // the index either
  const runs = opts.fromStoredContent
    ? resources.filter((r) => r.hasStoredContent).map((r) => ({ id: r.id, rebuildOnly: true }))
    : resources.filter((r) => r.url).map((r) => ({ id: r.id, rebuildOnly: false }))

  await Promise.all([
    syncPackageMetadata(db, deps, packageId),
    writeMarkedResourceDocs(db, deps, { packageId }),
    // In batches rather than a transaction per run; a refused batch still
    // fails the sync, which is what lets the same request be the retry
    pipeline.enqueueMany(runs).then(({ failed }) => {
      if (failed.length > 0) throw failed[0].reason
    }),
  ])
}

/**
 * Ask for the resources marked due to have their search documents rewritten
 * (ADR-053 §9.3).
 *
 * **Does not mark the row.** The mark belongs in the statement that made the
 * document wrong — separately, a crash between the two leaves a new abstract
 * with nothing recording that the index has not heard of it. This only asks,
 * and the job it asks for writes nothing for a row without a mark.
 *
 * Queued rather than written here, because the caller cannot retry: the
 * Summarize step records a failure and lets the run finish, and a retried edit
 * changes nothing to re-trigger on. One job serves every mark set before it
 * runs, so none is written while one is waiting. The enqueue is best-effort — a
 * queue that never heard leaves the row due, and the sweep comes back for it.
 */
export async function enqueueResourceDocSync(queue: QueueAdapter, log: Logger): Promise<void> {
  try {
    await requestResourceDocSync(queue)
  } catch (err) {
    log.error({ err }, 'Resource document sync enqueue failed; the sweep will retry')
  }
}

/** The enqueue itself, for a caller that wants the failure (the sweep) */
export async function requestResourceDocSync(queue: QueueAdapter): Promise<void> {
  await queue.enqueue(SYNC_RESOURCE_DOC_JOB_TYPE, {}, { unlessWaiting: true })
}

/**
 * {@link enqueueResourceDocSync}, when this resource is marked — for a caller
 * whose writes to the row are several and scattered, such as a pipeline run
 * (an abstract, a format a version settled), and which asks once at its end.
 */
export async function enqueueResourceDocSyncIfDue(
  db: Database,
  queue: QueueAdapter,
  resourceId: string,
  log: Logger
): Promise<void> {
  const [due] = await db
    .select({ id: resource.id })
    .from(resource)
    .where(and(eq(resource.id, resourceId), isNotNull(resource.docSyncDueAt)))
  if (due) await enqueueResourceDocSync(queue, log)
}

/** How many marked resources one bulk write carries */
const DOC_SYNC_BATCH = 200

/** How long an edit, having the lock, waits for a row another transaction holds */
const DOC_SYNC_EDIT_ROW_LOCK_WAIT_MS = 2_000

/**
 * How long the job waits for a row another transaction holds, once it has the
 * lock: waiting, it keeps every edit off the lock. Past it the batch rolls
 * back with its marks in place — the documents it wrote stand — and the
 * queue's retry, or the sweep, comes back for them.
 */
const DOC_SYNC_ROW_LOCK_WAIT_MS = 10_000

/** Bound the waits for other locks for the rest of the transaction */
const lockTimeout = (tx: Transaction, ms: number) =>
  tx.execute(sql`SELECT set_config('lock_timeout', ${`${ms}ms`}, true)`)

/** A resource the index holds a document for: live, of a published dataset (ADR-039) */
const indexedResource = () => and(eq(resource.state, 'active'), eq(packageTable.state, 'active'))

/**
 * Bring the documents of the marked resources `where` selects in line with
 * their rows, oldest mark first, and clear each mark only if it is still the
 * one read here. Called holding {@link RESOURCE_DOC_SYNC_LOCK}, which is what
 * keeps two writers of one document from landing out of order.
 *
 * **Compare-and-set, not a plain clear.** The writers that mark a row do not
 * take the lock — they would wait on the index. One landing while the
 * documents were being written leaves a newer mark, and clearing regardless
 * would drop it: a hide made in that window would stay out of the index's
 * knowledge. Unmatched, the row stays due and is taken again.
 *
 * What a row asks for follows from where it stands. A live resource of a public
 * dataset is written. A draft's is neither written nor removed: the index holds
 * nothing of a draft until publish writes it all (ADR-039), so its mark is only
 * cleared. Anything else — a deleted resource, one of a deleted dataset — has
 * its document removed: a writer that read the row while it was live may have
 * written it back.
 *
 * A document the index refuses keeps its mark and is reported, and the rest
 * are cleared: one bad document must not hold back every mark behind it. A
 * failure of the index itself — a removal, a bulk request refused whole —
 * throws, and the transaction takes the clears back with it.
 */
async function syncMarkedDocs(
  tx: Transaction,
  search: SearchAdapter,
  where?: SQL
): Promise<{ read: number; cleared: number; refused: string[] }> {
  const rows = await tx
    .select({
      ...resourceDocColumns,
      action: sql<'write' | 'remove' | 'clear'>`CASE
        WHEN ${packageTable.state} = 'draft' THEN 'clear'
        WHEN ${indexedResource()} THEN 'write'
        ELSE 'remove' END`,
      // As text: a Date keeps milliseconds where the column keeps
      // microseconds, so the mark would never match itself
      dueAt: sql<string>`${resource.docSyncDueAt}::text`,
    })
    .from(resource)
    .innerJoin(packageTable, eq(packageTable.id, resource.packageId))
    .where(and(isNotNull(resource.docSyncDueAt), where))
    .orderBy(asc(resource.docSyncDueAt))
    .limit(DOC_SYNC_BATCH)
  if (rows.length === 0) return { read: 0, cleared: 0, refused: [] }

  // Written before the marks are cleared, so a write that fails leaves them.
  // Side by side: each waits on the index, and the lock is held throughout.
  const refused = new Set<string>()
  const written = rows.filter((r) => r.action === 'write')
  const gone = rows.filter((r) => r.action === 'remove').map((r) => r.id)
  const [write, removal] = await Promise.allSettled([
    written.length > 0 && search.bulkIndexResources(written.map(buildResourceDoc)),
    gone.length > 0 && search.deleteResources(gone),
  ])
  // A removal failing is the index's failure, not one document's: thrown, for
  // the retry, as a bulk request refused whole is
  if (removal.status === 'rejected') throw removal.reason
  if (write.status === 'rejected') {
    if (!(write.reason instanceof BulkIndexError)) throw write.reason
    for (const id of write.reason.failedIds) refused.add(id)
  }

  const settled = rows.filter((r) => !refused.has(r.id))
  if (settled.length === 0) return { read: rows.length, cleared: 0, refused: [...refused] }
  const marks = sql.join(
    settled.map((r) => sql`(${r.id}::uuid, ${r.dueAt}::timestamptz)`),
    sql`, `
  )
  const cleared = await tx.execute(sql`
    UPDATE resource r SET doc_sync_due_at = NULL
    FROM (VALUES ${marks}) AS d(id, due_at)
    WHERE r.id = d.id AND r.doc_sync_due_at = d.due_at
    RETURNING r.id
  `)
  return { read: rows.length, cleared: cleared.rows.length, refused: [...refused] }
}

/** Whether a batch left nothing behind: short of a full one, and every row settled */
const drained = (batch: { read: number; cleared: number; refused: string[] }) =>
  batch.read < DOC_SYNC_BATCH && batch.cleared + batch.refused.length === batch.read

/**
 * The job's side: every marked resource, a batch at a time, until none is
 * left. A row marked again while its batch was written is read again by the
 * next; one the index refused is not, or a batch of refusals would stop the
 * rest behind it.
 *
 * The lock is taken per batch, so a job behind another, or behind an edit,
 * waits one batch and then takes turns with it. Refused documents are
 * returned for the log; their marks stay. A row held by another transaction
 * past {@link DOC_SYNC_ROW_LOCK_WAIT_MS} throws, for the queue to retry.
 */
export async function syncDueResourceDocs(
  db: Database,
  search: SearchAdapter,
  { rowLockWaitMs = DOC_SYNC_ROW_LOCK_WAIT_MS }: { rowLockWaitMs?: number } = {}
): Promise<{ synced: number; refused: string[] }> {
  let synced = 0
  const refused = new Set<string>()
  for (;;) {
    const skip = refused.size > 0 ? notInArray(resource.id, [...refused]) : undefined
    const batch = await withGlobalAdvisoryLock(db, RESOURCE_DOC_SYNC_LOCK, async (tx) => {
      // After the lock, not before: waiting a rebuild's batch out is expected
      await lockTimeout(tx, rowLockWaitMs)
      return syncMarkedDocs(tx, search, skip)
    })
    synced += batch.cleared
    for (const id of batch.refused) refused.add(id)
    if (drained(batch)) return { synced, refused: [...refused] }
  }
}

/**
 * An edit's side: write the documents of the resources it has just marked,
 * under the same lock as the job, so the edit is searchable on return and no
 * sync can land an older document after it.
 *
 * Does not wait for the lock: waiting, a request holds a pooled connection,
 * and a handful of edits behind one sync batch would leave every other request
 * without one. Nor does it write without the lock: a write that read the row
 * before another edit can land after the job has written that edit and cleared
 * its mark, and nothing is left to put it right — a hidden abstract answering
 * searches again.
 *
 * One batch at most: a request is not made to carry a whole dataset's
 * documents. Anything not settled here — the lock held, a document refused, a
 * mark set again meanwhile, more than a batch, a row held past
 * {@link DOC_SYNC_EDIT_ROW_LOCK_WAIT_MS}, a failure — keeps its mark, and the
 * job is asked for, as long as something in scope is marked. Best-effort, like
 * the rest of the post-commit tail.
 */
export async function writeMarkedResourceDocs(
  db: Database,
  deps: PackageSyncDeps,
  /** The resources the edit wrote — narrowed to the marked ones there */
  scope: { resourceIds: string[] } | { packageId: string }
): Promise<void> {
  if ('resourceIds' in scope && scope.resourceIds.length === 0) return
  const where =
    'packageId' in scope
      ? eq(resource.packageId, scope.packageId)
      : inArray(resource.id, scope.resourceIds)
  let settled = false
  try {
    settled = await db.transaction(async (tx) => {
      if (!(await tryLockInTransaction(tx, RESOURCE_DOC_SYNC_LOCK, ''))) {
        // Nothing marked is nothing for the job either
        const [due] = await tx
          .select({ id: resource.id })
          .from(resource)
          .where(and(isNotNull(resource.docSyncDueAt), where))
          .limit(1)
        return !due
      }
      await lockTimeout(tx, DOC_SYNC_EDIT_ROW_LOCK_WAIT_MS)
      const batch = await syncMarkedDocs(tx, deps.search, where)
      // A refusal is the job's to report
      return batch.read === 0 || (drained(batch) && batch.refused.length === 0)
    })
  } catch (err) {
    if (!isLockTimeout(err)) {
      deps.logger.error({ err }, 'Resource document write failed; the sync job will retry')
    }
  }
  if (!settled) await enqueueResourceDocSync(deps.queue, deps.logger)
}

/**
 * Build a DatasetDoc from DB and upsert it into the search index (kukan-packages).
 * Does NOT include resource-level data — resource documents are written apart.
 * Returns false when the package is not active (nothing indexed).
 */
export async function indexPackageMetadata(
  db: Database,
  search: SearchAdapter,
  packageId: string
): Promise<boolean> {
  const [pkg] = await db
    .select({
      id: packageTable.id,
      name: packageTable.name,
      title: packageTable.title,
      notes: packageTable.notes,
      ownerOrg: packageTable.ownerOrg,
      private: packageTable.private,
      creatorUserId: packageTable.creatorUserId,
      licenseId: packageTable.licenseId,
      created: packageTable.created,
      updated: packageTable.updated,
    })
    .from(packageTable)
    .where(and(eq(packageTable.id, packageId), eq(packageTable.state, 'active')))
    .limit(1)

  if (!pkg) return false

  const [orgRow, groups, tags] = await Promise.all([
    pkg.ownerOrg
      ? db
          .select({ name: organization.name })
          .from(organization)
          .where(eq(organization.id, pkg.ownerOrg))
          .limit(1)
          .then(([r]) => r ?? null)
      : Promise.resolve(null),
    db
      .select({ name: group.name })
      .from(packageGroup)
      .innerJoin(group, eq(packageGroup.groupId, group.id))
      .where(eq(packageGroup.packageId, packageId)),
    db
      .select({ name: tag.name })
      .from(packageTag)
      .innerJoin(tag, eq(packageTag.tagId, tag.id))
      .where(eq(packageTag.packageId, packageId))
      .orderBy(tag.name),
  ])

  const doc: DatasetDoc = {
    id: pkg.id,
    name: pkg.name,
    title: pkg.title ?? undefined,
    notes: pkg.notes ?? undefined,
    organization: orgRow?.name ?? undefined,
    license_id: pkg.licenseId ?? undefined,
    groups: groups.map((g) => g.name),
    tags: tags.map((t) => t.name),
    private: pkg.private,
    owner_org_id: pkg.ownerOrg ?? undefined,
    creator_user_id: pkg.creatorUserId ?? undefined,
    created: pkg.created,
    updated: pkg.updated,
  }

  await search.indexPackage(doc)
  return true
}

/** Resource rows the index may hold: active, under an active package (ADR-039). */
function activeResourceDocRows(db: Database | Transaction, where: SQL | undefined) {
  return db
    .select(resourceDocColumns)
    .from(resource)
    .innerJoin(packageTable, eq(packageTable.id, resource.packageId))
    .where(and(indexedResource(), where))
}

/** What a ResourceDoc is built from — the shape resourceDocColumns selects. */
type ResourceRowForDoc = Awaited<ReturnType<typeof activeResourceDocRows>>[number]

function buildResourceDoc(row: ResourceRowForDoc): ResourceDoc {
  return {
    id: row.id,
    packageId: row.packageId,
    name: row.name ?? undefined,
    description: row.description ?? undefined,
    format: row.format ?? undefined,
    section: row.section ?? undefined,
    summary: row.summary ?? undefined,
  }
}

/**
 * Sync a package after its arrangement changed (ADR-050). The order is in
 * neither the resource documents nor the vectors; the section labels are in
 * both, so only a relabel has anything to write — the documents through the
 * sync's lock, and the vectors through the embed job. The relabel marked both.
 */
export async function syncPackageResources(
  db: Database,
  deps: PackageSyncDeps,
  packageId: string,
  { relabelled }: { relabelled: boolean }
): Promise<void> {
  if (!relabelled) return
  await Promise.all([
    // Every resource the relabel marked, a draft's included: cleared there
    // without a write (see `syncMarkedDocs`)
    writeMarkedResourceDocs(db, deps, { packageId }),
    enqueueResourceEmbedsIfDue(db, deps, { packageId }),
  ])
}

/**
 * What follows a resource row being written, whichever route wrote it: a
 * pipeline run for each link resource (an upload's starts at upload-complete),
 * and the rows' search docs, which the write marked, through the sync's lock.
 * Drafts have nothing in the index until publish (ADR-039): their marks are
 * cleared without a write.
 *
 * Best-effort: the rows are the record, and a run the queue dropped or a doc
 * the index refused is caught by the next edit, the hourly sweeps or a
 * rebuild. Callers keep the whole post-commit tail best-effort for the same
 * reason — a request that fails after the commit reports a package that
 * exists as not created, and the retry then refuses its name.
 */
export async function settleResourceWrites(
  db: Database,
  deps: PackageSyncDeps,
  resources: { id: string; url: string | null; urlType: string | null }[]
): Promise<void> {
  if (resources.length === 0) return
  const runs = resources.filter((r) => r.url && r.urlType !== 'upload').map((r) => ({ id: r.id }))
  await Promise.all([
    new PipelineService(db, deps.queue).enqueueMany(runs).then(({ failed }) => {
      for (const { id, reason } of failed) {
        deps.logger.error({ err: reason, resourceId: id }, 'Best-effort pipeline enqueue failed')
      }
    }),
    writeMarkedResourceDocs(db, deps, { resourceIds: resources.map((r) => r.id) }),
  ])
}

// ------------------------------------------------------------------
// Bulk rebuild
// ------------------------------------------------------------------

const BATCH_SIZE = 100

export interface RebuildMetadataResult {
  packagesIndexed: number
  resourcesIndexed: number
  packagesRemoved: number
  resourcesRemoved: number
}

/**
 * Rebuild package and resource search indices from DB.
 * Content index is not rebuilt here (requires pipeline re-processing).
 *
 * **Overwrites, then drops what is left over — never empties first.** An index
 * with no package documents is what the worker's health check reads as lost,
 * and it answers by queueing a reindex of the whole catalogue, contents and
 * embeddings included. Emptying first opened that window on every rebuild, and
 * public search answered nothing while it was open.
 */
export async function rebuildMetadataIndex(
  db: Database,
  search: SearchAdapter,
  log: Logger
): Promise<RebuildMetadataResult> {
  log.info('Starting metadata index rebuild')

  const packages = await db
    .select({ id: packageTable.id })
    .from(packageTable)
    .where(eq(packageTable.state, 'active'))

  let packagesIndexed = 0
  let resourcesIndexed = 0

  for (let i = 0; i < packages.length; i += BATCH_SIZE) {
    const batch = packages.slice(i, i + BATCH_SIZE)
    const batchIds = batch.map((p) => p.id)

    const [details, allGroups, allTags] = await Promise.all([
      db
        .select({
          id: packageTable.id,
          name: packageTable.name,
          title: packageTable.title,
          notes: packageTable.notes,
          ownerOrg: packageTable.ownerOrg,
          private: packageTable.private,
          creatorUserId: packageTable.creatorUserId,
          licenseId: packageTable.licenseId,
          created: packageTable.created,
          updated: packageTable.updated,
        })
        .from(packageTable)
        .where(inArray(packageTable.id, batchIds)),
      db
        .select({ packageId: packageGroup.packageId, name: group.name })
        .from(packageGroup)
        .innerJoin(group, eq(packageGroup.groupId, group.id))
        .where(inArray(packageGroup.packageId, batchIds)),
      db
        .select({ packageId: packageTag.packageId, name: tag.name })
        .from(packageTag)
        .innerJoin(tag, eq(packageTag.tagId, tag.id))
        .where(inArray(packageTag.packageId, batchIds))
        .orderBy(tag.name),
    ])

    const orgIds = [...new Set(details.map((d) => d.ownerOrg).filter((id): id is string => !!id))]
    const orgMap = new Map<string, string>()
    if (orgIds.length > 0) {
      const orgs = await db
        .select({ id: organization.id, name: organization.name })
        .from(organization)
        .where(inArray(organization.id, orgIds))
      for (const o of orgs) orgMap.set(o.id, o.name)
    }

    const groupsByPkg = new Map<string, string[]>()
    for (const g of allGroups) {
      let arr = groupsByPkg.get(g.packageId)
      if (!arr) {
        arr = []
        groupsByPkg.set(g.packageId, arr)
      }
      arr.push(g.name)
    }
    const tagsByPkg = new Map<string, string[]>()
    for (const t of allTags) {
      let arr = tagsByPkg.get(t.packageId)
      if (!arr) {
        arr = []
        tagsByPkg.set(t.packageId, arr)
      }
      arr.push(t.name)
    }

    const packageDocs: DatasetDoc[] = details.map((detail) => {
      return {
        id: detail.id,
        name: detail.name,
        title: detail.title ?? undefined,
        notes: detail.notes ?? undefined,
        organization: detail.ownerOrg ? orgMap.get(detail.ownerOrg) : undefined,
        license_id: detail.licenseId ?? undefined,
        groups: groupsByPkg.get(detail.id) ?? [],
        tags: tagsByPkg.get(detail.id) ?? [],
        private: detail.private,
        owner_org_id: detail.ownerOrg ?? undefined,
        creator_user_id: detail.creatorUserId ?? undefined,
        created: detail.created,
        updated: detail.updated,
      }
    })

    // The resources' documents a batch at a time, each read and written under
    // the sync's lock: a resource edited between the read and the write would
    // otherwise get the older document back after its own write had cleared
    // its mark. Held per batch, not for the datasets', which are not written
    // through it — holding it longer would only keep the others waiting.
    let after: string | undefined
    for (;;) {
      const written = await withGlobalAdvisoryLock(db, RESOURCE_DOC_SYNC_LOCK, async (tx) => {
        const rows = await activeResourceDocRows(
          tx,
          and(inArray(resource.packageId, batchIds), after ? gt(resource.id, after) : undefined)
        )
          .orderBy(asc(resource.id))
          .limit(DOC_SYNC_BATCH)
        if (rows.length > 0) await search.bulkIndexResources(rows.map(buildResourceDoc))
        return rows
      })
      resourcesIndexed += written.length
      if (written.length < DOC_SYNC_BATCH) break
      after = written[written.length - 1].id
    }

    if (packageDocs.length > 0) {
      await search.bulkIndexPackages(packageDocs)
      packagesIndexed += packageDocs.length
    }
  }

  // Packages first: deleting one takes its children with it, so the resource
  // pass does not find them again.
  // Under the sync's lock, a page at a time: a restore writes its resources'
  // documents under it, and a delete — this one takes the children with it —
  // landing between a page's check and its deletes would lose them
  const underLock = <T>(page: (q: Database | Transaction) => Promise<T>) =>
    withGlobalAdvisoryLock(db, RESOURCE_DOC_SYNC_LOCK, page)
  const packagesRemoved = await dropIndexedWithoutRow(
    (after, limit) => search.indexedDocumentIds('package', after, limit),
    (ids, q) =>
      q
        .select({ id: packageTable.id })
        .from(packageTable)
        .where(and(inArray(packageTable.id, ids), eq(packageTable.state, 'active'))),
    async (ids) => {
      for (const id of ids) await search.deletePackage(id)
    },
    underLock
  )
  const resourcesRemoved = await dropIndexedWithoutRow(
    (after, limit) => search.indexedDocumentIds('resource', after, limit),
    (ids, q) => activeResourceDocRows(q, inArray(resource.id, ids)),
    (ids) => search.deleteResources(ids),
    underLock
  )

  const result = { packagesIndexed, resourcesIndexed, packagesRemoved, resourcesRemoved }
  log.info(result, 'Metadata index rebuild complete')
  return result
}

const PRUNE_PAGE = 1_000

/**
 * Walk the ids the index holds, a page at a time, and remove each one the
 * database no longer has a row for that the index may hold.
 *
 * The database is asked page by page, not checked against a list read
 * earlier: a dataset published since then is in the index and not in that
 * list. An id that is not a UUID has no row, and asking for one would fail
 * the whole query on the uuid column.
 */
export async function dropIndexedWithoutRow(
  list: (after: string | undefined, limit: number) => Promise<string[]>,
  indexable: (ids: string[], q: Database | Transaction) => Promise<{ id: string }[]>,
  /** The page's ids the database has no row for, removed together */
  remove: (ids: string[]) => Promise<void>,
  /** How a page's check and its deletes run — under a lock, where a writer must not come between them */
  runPage: <T>(page: (q: Database | Transaction) => Promise<T>) => Promise<T>
): Promise<number> {
  let after: string | undefined
  let removed = 0
  for (;;) {
    const indexed = await list(after, PRUNE_PAGE)
    if (indexed.length === 0) break
    removed += await runPage(async (q) => {
      const ids = indexed.filter(isUuid)
      const keep = new Set(ids.length > 0 ? (await indexable(ids, q)).map((r) => r.id) : [])
      const gone = indexed.filter((id) => !keep.has(id))
      if (gone.length > 0) await remove(gone)
      return gone.length
    })
    if (indexed.length < PRUNE_PAGE) break
    after = indexed[indexed.length - 1]
  }
  return removed
}
