/**
 * Search index helpers.
 * - indexPackageMetadata: single-record upsert for package CUD operations
 * - indexResourceMetadata: single-record upsert for resource CUD operations
 * - rebuildMetadataIndex: batch rebuild of all packages + resources
 */

import { eq, and, inArray, sql, type SQL } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import {
  packageTable,
  resource,
  organization,
  group,
  packageGroup,
  packageTag,
  tag,
} from '@kukan/db'
import type { SearchAdapter, DatasetDoc, ResourceDoc } from '@kukan/search-adapter'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'
import { EMBED_JOB_TYPE, type Logger } from '@kukan/shared'
import { ResourceService, resourceDocColumns } from './resource-service'
import { PipelineService } from './pipeline-service'
import { leasePassed } from './lease'

/** The adapters every package-metadata sync needs — a structural subset of the
 *  route context vars, so routes can pass `c.var` directly. */
export interface PackageSyncDeps {
  search: SearchAdapter
  queue: QueueAdapter
  ai: AIAdapter
  logger: Logger
}

/**
 * Sync one package after a metadata change: upsert its search doc and
 * (re)enqueue its embedding. Always use this from routes (rather than calling
 * indexPackageMetadata directly) so a new call site cannot forget the embed
 * half of the pair. Non-active packages (drafts, ADR-039) are skipped entirely,
 * so callers can invoke unconditionally.
 */
export async function syncPackageMetadata(
  db: Database,
  deps: PackageSyncDeps,
  packageId: string
): Promise<void> {
  const indexed = await indexPackageMetadata(db, deps.search, packageId)
  if (indexed) {
    await enqueuePackageEmbed(db, deps.queue, deps.ai, packageId, deps.logger)
  }
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
 * Failures propagate: publish and restore are both idempotent, so re-sending
 * the same request retries the whole sync.
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
    deps.search.bulkIndexResources(resources.map(buildResourceDoc)),
    ...runs.map((r) => pipeline.enqueue(r.id, { rebuildOnly: r.rebuildOnly })),
  ])
}

/**
 * Enqueue embedding (re)generation for a package whose metadata (or whose
 * resources' metadata) changed. No-op when embedding is unavailable (NoOp
 * adapter). Deliberately not gated on any search-side toggle — disabling hybrid
 * search only stops reading vectors at query time; writes continue so vectors
 * stay fresh. Enqueue failures are logged but never fail the request —
 * embeddings are eventually consistent (ADR-034).
 */
export async function enqueuePackageEmbed(
  db: Database,
  queue: QueueAdapter,
  ai: AIAdapter,
  packageId: string,
  logger: Logger
): Promise<void> {
  await enqueueEmbeds(db, queue, ai, eq(packageTable.id, packageId), logger)
}

/**
 * How long one queued embed stands for every change to a package.
 *
 * The embedding covers the dataset and its resources together, so adding a
 * resource is a change to it — and a bulk import is one change per resource,
 * measured at ~5,500 jobs for 298 datasets. The worker takes one message at a
 * time, so those queue behind the pipeline runs the same import is producing.
 *
 * The job is queued to run after the window ({@link EMBED_DELAY_S}), which is
 * what makes suppressing the rest of it safe: the one job reads the dataset as
 * it stands once the changes it stands for are in. Long enough to collapse an
 * import's per-resource writes, short enough that a single edit is embedded
 * while the editor is still looking at it.
 */
export const EMBED_DEBOUNCE_MS = 60_000

/**
 * The delay on the job, past the window by a few seconds. The window is kept
 * on the database clock and the delay on the queue's; a job that ran before
 * the window closed would miss a change that landed between the two, and
 * these seconds are the room the clocks are allowed to disagree by.
 */
export const EMBED_DELAY_S = EMBED_DEBOUNCE_MS / 1000 + 5

/**
 * Queue an embed for every active package matching `where` whose window is
 * open, and hold the window for each. The single-package path and the bulk
 * job both come through here, so a claim always has exactly one job behind it
 * and a job never goes out without a claim.
 *
 * The claim is one statement on the rows, not anything in a process: two API
 * tasks handling the same edit, or a redelivery of the bulk job, find the
 * window already held. Enqueue failures are counted and logged, never thrown.
 */
export async function enqueueEmbeds(
  db: Database,
  queue: QueueAdapter,
  ai: AIAdapter,
  where: SQL,
  logger: Logger
): Promise<{ enqueued: number; failed: number }> {
  if (!ai.getEmbeddingInfo()) return { enqueued: 0, failed: 0 }
  const claimed = await db
    .update(packageTable)
    .set({ embeddingQueuedAt: sql`now()` })
    .where(
      and(
        where,
        eq(packageTable.state, 'active'),
        leasePassed(packageTable.embeddingQueuedAt, EMBED_DEBOUNCE_MS)
      )
    )
    .returning({ id: packageTable.id, stamp: sql<string>`${packageTable.embeddingQueuedAt}::text` })

  let enqueued = 0
  const unqueued: string[] = []
  for (let i = 0; i < claimed.length; i += ENQUEUE_BATCH_SIZE) {
    const batch = claimed.slice(i, i + ENQUEUE_BATCH_SIZE)
    const results = await Promise.allSettled(
      batch.map(({ id }) =>
        queue.enqueue(EMBED_JOB_TYPE, { packageId: id }, { delaySeconds: EMBED_DELAY_S })
      )
    )
    results.forEach((result, j) => {
      if (result.status === 'fulfilled') enqueued++
      else {
        unqueued.push(batch[j].id)
        logger.error(
          { err: result.reason, packageId: batch[j].id },
          'Failed to enqueue embed-package job'
        )
      }
    })
  }

  // A window with no job behind it would hold until it ran out, and every
  // change inside it — a bulk import's next resource, say — would be the
  // change that queued nothing. Given back only where the stamp is still ours:
  // one statement claimed every row above at one `now()`, and a row another
  // caller has claimed since carries a later one.
  if (unqueued.length > 0) {
    await db
      .update(packageTable)
      .set({ embeddingQueuedAt: null })
      .where(
        and(
          inArray(packageTable.id, unqueued),
          // As text: a Date round-trip keeps milliseconds where the column
          // keeps microseconds, and the stamp would never match itself.
          sql`${packageTable.embeddingQueuedAt} = ${claimed[0].stamp}::timestamptz`
        )
      )
  }
  return { enqueued, failed: unqueued.length }
}

const ENQUEUE_BATCH_SIZE = 100

/**
 * Build a DatasetDoc from DB and upsert it into the search index (kukan-packages).
 * Does NOT include resource-level data — use indexResourceMetadata() for that.
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

  const [resources, orgRow, groups, tags] = await Promise.all([
    // Only fetch format for the formats facet
    db
      .select({ format: resource.format })
      .from(resource)
      .where(and(eq(resource.packageId, packageId), eq(resource.state, 'active'))),
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
      .where(eq(packageTag.packageId, packageId)),
  ])

  const formatSet = new Set(
    resources.map((r) => r.format?.toUpperCase()).filter((f): f is string => !!f)
  )

  const doc: DatasetDoc = {
    id: pkg.id,
    name: pkg.name,
    title: pkg.title ?? undefined,
    notes: pkg.notes ?? undefined,
    organization: orgRow?.name ?? undefined,
    license_id: pkg.licenseId ?? undefined,
    groups: groups.map((g) => g.name),
    tags: tags.map((t) => t.name),
    formats: [...formatSet],
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
function activeResourceDocRows(db: Database, where: SQL) {
  return db
    .select(resourceDocColumns)
    .from(resource)
    .innerJoin(packageTable, eq(packageTable.id, resource.packageId))
    .where(and(eq(resource.state, 'active'), eq(packageTable.state, 'active'), where))
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
  }
}

/**
 * Sync a package after its arrangement changed (ADR-050): the embedding text
 * is built in the resources' order, so it is re-enqueued either way; the
 * resource docs carry the labels and not the order, so they are rewritten
 * only when `relabelled`. A package that is not active has nothing in the
 * index (ADR-039), so callers can invoke unconditionally.
 */
export async function syncPackageResources(
  db: Database,
  deps: PackageSyncDeps,
  packageId: string,
  { relabelled }: { relabelled: boolean }
): Promise<void> {
  const rows = await activeResourceDocRows(db, eq(resource.packageId, packageId))
  if (rows.length === 0) return
  await Promise.all([
    relabelled && deps.search.bulkIndexResources(rows.map(buildResourceDoc)),
    enqueuePackageEmbed(db, deps.queue, deps.ai, packageId, deps.logger),
  ])
}

/**
 * What follows a resource row being written, whichever route wrote it: a
 * pipeline run for each link resource (an upload's starts at upload-complete),
 * and the rows' search docs in one bulk request. Drafts have nothing in the
 * index until publish (ADR-039), which the doc query already excludes.
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
    activeResourceDocRows(
      db,
      inArray(
        resource.id,
        resources.map((r) => r.id)
      )
    )
      .then(async (rows) => {
        if (rows.length > 0) await deps.search.bulkIndexResources(rows.map(buildResourceDoc))
      })
      .catch((err) => {
        deps.logger.error({ err }, 'Best-effort resource index failed')
      }),
  ])
}

/**
 * Index a single resource's metadata into kukan-resources.
 * Does NOT include extractedText — that is added by the pipeline Index step.
 */
export async function indexResourceMetadata(
  db: Database,
  search: SearchAdapter,
  resourceId: string
): Promise<void> {
  // Draft resources are indexed at publish (ADR-039)
  const [res] = await activeResourceDocRows(db, eq(resource.id, resourceId)).limit(1)

  if (!res) return

  await search.indexResource(buildResourceDoc(res))
}

// ------------------------------------------------------------------
// Bulk rebuild
// ------------------------------------------------------------------

const BATCH_SIZE = 100

export interface RebuildMetadataResult {
  packagesIndexed: number
  resourcesIndexed: number
}

/**
 * Rebuild package and resource search indices from DB.
 * Content index is not rebuilt here (requires pipeline re-processing).
 * @param clearFirst - If true, delete all documents before re-indexing (default: true).
 *                     Set to false for auto-recovery where indices are already empty.
 */
export async function rebuildMetadataIndex(
  db: Database,
  search: SearchAdapter,
  log: Logger,
  clearFirst = true
): Promise<RebuildMetadataResult> {
  log.info('Starting metadata index rebuild')

  if (clearFirst) {
    await search.deleteAllPackages()
    await search.deleteAllResources()
  }

  const packages = await db
    .select({ id: packageTable.id })
    .from(packageTable)
    .where(eq(packageTable.state, 'active'))

  let packagesIndexed = 0
  let resourcesIndexed = 0

  for (let i = 0; i < packages.length; i += BATCH_SIZE) {
    const batch = packages.slice(i, i + BATCH_SIZE)
    const batchIds = batch.map((p) => p.id)

    const [details, allResources, allGroups, allTags] = await Promise.all([
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
        .select(resourceDocColumns)
        .from(resource)
        .where(and(inArray(resource.packageId, batchIds), eq(resource.state, 'active'))),
      db
        .select({ packageId: packageGroup.packageId, name: group.name })
        .from(packageGroup)
        .innerJoin(group, eq(packageGroup.groupId, group.id))
        .where(inArray(packageGroup.packageId, batchIds)),
      db
        .select({ packageId: packageTag.packageId, name: tag.name })
        .from(packageTag)
        .innerJoin(tag, eq(packageTag.tagId, tag.id))
        .where(inArray(packageTag.packageId, batchIds)),
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

    const resourcesByPkg = new Map<string, typeof allResources>()
    for (const r of allResources) {
      let arr = resourcesByPkg.get(r.packageId)
      if (!arr) {
        arr = []
        resourcesByPkg.set(r.packageId, arr)
      }
      arr.push(r)
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
      const pkgResources = resourcesByPkg.get(detail.id) ?? []
      const formatSet = new Set(
        pkgResources.map((r) => r.format?.toUpperCase()).filter((f): f is string => !!f)
      )
      return {
        id: detail.id,
        name: detail.name,
        title: detail.title ?? undefined,
        notes: detail.notes ?? undefined,
        organization: detail.ownerOrg ? orgMap.get(detail.ownerOrg) : undefined,
        license_id: detail.licenseId ?? undefined,
        groups: groupsByPkg.get(detail.id) ?? [],
        tags: tagsByPkg.get(detail.id) ?? [],
        formats: [...formatSet],
        private: detail.private,
        owner_org_id: detail.ownerOrg ?? undefined,
        creator_user_id: detail.creatorUserId ?? undefined,
        created: detail.created,
        updated: detail.updated,
      }
    })

    const resourceDocs: ResourceDoc[] = allResources.map(buildResourceDoc)

    if (packageDocs.length > 0) {
      await search.bulkIndexPackages(packageDocs)
      packagesIndexed += packageDocs.length
    }
    if (resourceDocs.length > 0) {
      await search.bulkIndexResources(resourceDocs)
      resourcesIndexed += resourceDocs.length
    }
  }

  log.info({ packagesIndexed, resourcesIndexed }, 'Metadata index rebuild complete')
  return { packagesIndexed, resourcesIndexed }
}
