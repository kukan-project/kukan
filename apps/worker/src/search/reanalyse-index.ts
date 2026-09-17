import { and, eq, gte, inArray } from 'drizzle-orm'
import { type Database, resource, resourcePipeline, resourcePipelineStep } from '@kukan/db'
import { rebuildMetadataIndex } from '@kukan/api/services/search-index'
import { markContentUnindexed } from '@kukan/api/services/content-index-record'
import { PipelineService } from '@kukan/api/services/pipeline-service'
import type { Logger } from '@kukan/shared'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { SearchAdapter } from '@kukan/search-adapter'

const CONTENT_PAGE = 1_000

/**
 * Rebuild the search index under the analysis the code now defines (ADR-025),
 * then put back what the copy could not see.
 *
 * A write that lands after `_reindex` starts goes to the index being replaced
 * and is dropped with it. Three of those are not merely stale:
 *
 * - a dataset made private stays public, because the search path filters on the
 *   indexed `private` field and nothing re-checks it against the database;
 * - a deleted resource keeps its content, because content hangs off the package
 *   rather than the resource, so chunks of a resource that is gone are still
 *   reached through a package that is not;
 * - content another worker indexed during the copy is lost, and the row still
 *   says it is indexed, so no ordinary run will write it again — and where that
 *   write was a replacement, the text it replaced comes back with it.
 *
 * All three are repaired here rather than in a job queued behind this one: the
 * message is not acknowledged until the index tells the truth, so a queue with
 * a backlog delays the re-analysis instead of leaving a window where the search
 * answers with what was meant to be hidden.
 */
export async function reanalyseSearchIndex(
  db: Database,
  search: SearchAdapter | undefined,
  queue: QueueAdapter,
  log: Logger
): Promise<{ from: string; to: string; documents: number } | null> {
  if (!search) {
    log.warn('Re-analysis skipped — this deployment has no search index')
    return null
  }
  // A redelivered message must not copy the catalogue a second time. A cluster
  // that cannot answer throws, rather than letting this job acknowledge a
  // re-analysis it never did.
  const copied = (await search.analysisStale()) ? await search.reanalyseIndex() : null
  if (copied) log.info(copied, 'Search index re-analysed')

  // The window belongs to the index, not to this delivery. An attempt that
  // swapped and then failed part-way through the repair leaves the marker on
  // the live index, and the next delivery finds the same window rather than a
  // new one that would look back at nothing.
  const copyStartedAt = await search.pendingRepair()
  if (!copyStartedAt) return copied

  const rebuilt = await rebuildMetadataIndex(db, search, log, true)
  const dropped = await dropContentWithoutResource(db, search, log)
  const rewritten = await rewriteContentWrittenDuringTheCopy(db, search, queue, copyStartedAt, log)
  // Marked once the index no longer says anything untrue. The rebuilds queued
  // above may still be running, and one that fails leaves content missing
  // rather than content exposed — and says where: the run records `error` on
  // the resource's pipeline row, which is what the admin jobs screen lists,
  // with a re-run beside it. The row's `contentIndexed` stays false until a run
  // writes it, so the gap is in the database and not only in the queue.
  await search.markRepaired()
  log.info(
    { ...rebuilt, contentDropped: dropped, contentRewritten: rewritten },
    'Search index repaired after the copy'
  )
  return copied
}

/** Content chunks of resources the database no longer has */
async function dropContentWithoutResource(
  db: Database,
  search: SearchAdapter,
  log: Logger
): Promise<number> {
  let after: string | undefined
  let dropped = 0
  for (;;) {
    const indexed = await search.indexedContentResources(after, CONTENT_PAGE)
    if (indexed.length === 0) break
    const live = await db
      .select({ id: resource.id })
      .from(resource)
      .where(inArray(resource.id, indexed))
    const alive = new Set(live.map((r) => r.id))
    for (const id of indexed) {
      if (alive.has(id)) continue
      log.warn({ resourceId: id }, 'Dropping content indexed for a resource that is gone')
      await search.deleteContent(id)
      dropped++
    }
    if (indexed.length < CONTENT_PAGE) break
    after = indexed[indexed.length - 1]
  }
  return dropped
}

/**
 * Resources whose Index step finished while the copy was running.
 *
 * Their chunks went to the index being replaced, and what the copy carried in
 * their place is whatever those writes replaced. So the stale chunks go first,
 * and then the row's `contentIndexed` — which is what stops an ordinary run
 * writing them again — is retracted and the resource re-run from storage, so
 * nothing is fetched. The window is the copy, so this is a handful of
 * resources, and selecting one the copy did carry costs a rebuild nobody needed
 * rather than a gap nobody sees.
 */
async function rewriteContentWrittenDuringTheCopy(
  db: Database,
  search: SearchAdapter,
  queue: QueueAdapter,
  startedAt: Date,
  log: Logger
): Promise<number> {
  const rows = await db
    .selectDistinct({ resourceId: resourcePipeline.resourceId })
    .from(resourcePipelineStep)
    .innerJoin(resourcePipeline, eq(resourcePipelineStep.pipelineId, resourcePipeline.id))
    .where(
      and(
        eq(resourcePipelineStep.stepName, 'index'),
        gte(resourcePipelineStep.completedAt, startedAt)
      )
    )
  if (rows.length === 0) return 0

  for (const { resourceId } of rows) {
    log.warn({ resourceId }, 'Content was indexed during the copy; rebuilding it')
    // Deleted here rather than left to the run queued below. What the copy
    // carried is the text that write replaced, and leaving it searchable until
    // a backlog clears — or for good, if that message reaches the dead-letter
    // queue — is the thing this repair exists to prevent. A gap is recoverable;
    // serving what someone removed is not.
    await search.deleteContent(resourceId)
    await markContentUnindexed(db, { resourceId })
  }
  const { enqueued, failed } = await new PipelineService(db, queue).enqueueMany(
    rows.map(({ resourceId }) => ({ id: resourceId, rebuildOnly: true }))
  )
  if (failed.length > 0) {
    throw new Error(`Could not requeue ${failed.length} resources indexed during the copy`)
  }
  return enqueued
}
