/**
 * Indexing content again without interpreting it (ADR-021).
 *
 * A chunk's size, and the way a table's profile or a document's text becomes
 * index lines, are fixed when the worker writes the content. A change to them
 * reaches a running deployment only as each resource is indexed again, and
 * nothing else rewrites a resource whose bytes have not changed. The runs
 * queued here (`indexOnly`) read what the last interpretation left instead of
 * interpreting again.
 *
 * Asked for from the search admin page, and from the dashboard notice that
 * counts resources still holding a chunk larger than the size in force.
 */

import { and, asc, eq, gt, inArray, isNotNull, type SQL } from 'drizzle-orm'
import { type Database, type Transaction, packageTable, resource } from '@kukan/db'
import { PIPELINE_JOB_TYPE, contentTypeOf, inTurn, isUuid } from '@kukan/shared'
import { resourcesWithReadyJobs, type JobQueue } from '@kukan/queue'
import type { SearchAdapter } from '@kukan/search-adapter'
import { CONTENT_REINDEX_LOCK, lockInTransaction } from '../concurrency/advisory-lock'
import { PipelineService } from '../pipeline/pipeline-service'
import { markContentUnindexed } from './content-index-record'
import { dropIndexedWithoutRow } from './search-index'

const PAGE = 1_000

/**
 * Index every resource's content again.
 *
 * The content index is not emptied first, as the reprocess of every resource
 * does: each run replaces its own resource's chunks, so search keeps the old
 * ones until then. Content no run would replace is dropped instead — a resource
 * that is gone or deleted, one outside a published dataset (Index writes
 * nothing for those, ADR-039), one of a format the index takes nothing from,
 * and one with no stored object, which only a fetch could rebuild. Left, it
 * keeps whatever it was cut under, and the notice would count it for good.
 */
export async function requestContentReindex(
  db: Database,
  search: SearchAdapter,
  queue: JobQueue
): Promise<{ enqueued: number; dropped: number }> {
  const dropped = await dropIndexedWithoutRow(
    (after, limit) => search.indexedContentResources(after, limit),
    async (ids, q) => (await reindexable(q, inArray(resource.id, ids))).map((id) => ({ id })),
    async (ids, q) => {
      for (const id of ids) {
        await search.deleteContent(id)
        if (isUuid(id)) await markContentUnindexed(q, { resourceId: id })
      }
    },
    (page) => underLock(db, queue, page)
  )

  const pipeline = new PipelineService(db, queue)
  let enqueued = 0
  let after: string | undefined
  for (;;) {
    const page = await underLock(db, queue, async (tx) => {
      const rows = await tx
        .select({ id: resource.id })
        .from(resource)
        .where(after ? gt(resource.id, after) : undefined)
        .orderBy(asc(resource.id))
        .limit(PAGE)
      if (rows.length === 0) return rows
      const ids = await reindexable(
        tx,
        inArray(
          resource.id,
          rows.map((r) => r.id)
        )
      )
      enqueued += await queueReindex(pipeline, tx, ids)
      return rows
    })
    if (page.length < PAGE) return { enqueued, dropped }
    after = page.at(-1)!.id
  }
}

/**
 * Of the resources `where` picks, those a run would index again: live, in a
 * published dataset, with an object to read, of a format the index takes
 * something from.
 */
async function reindexable(q: Database | Transaction, where: SQL): Promise<string[]> {
  const rows = await q
    .select({ id: resource.id, format: resource.format })
    .from(resource)
    .innerJoin(packageTable, eq(resource.packageId, packageTable.id))
    .where(
      and(
        where,
        eq(resource.state, 'active'),
        eq(packageTable.state, 'active'),
        isNotNull(resource.storageKey)
      )
    )
  return rows.filter((r) => contentTypeOf(r.format)).map((r) => r.id)
}

/**
 * A page of work in one transaction under one lock, so two passes — two
 * presses, from the notice or the admin page — cannot both find a resource
 * with nothing on its way and queue it twice. The transaction is the only
 * connection a pass holds: a worker with a pool of one still gets through.
 */
function underLock<T>(
  db: Database,
  queue: JobQueue,
  page: (tx: Transaction) => Promise<T>
): Promise<T> {
  // In this process, in turn before a connection is taken (ADR-058 §7)
  return inTurn(CONTENT_REINDEX_LOCK, () =>
    queue.transaction(db, async (tx) => {
      await lockInTransaction(tx, CONTENT_REINDEX_LOCK, '')
      return page(tx)
    })
  )
}

/**
 * Queue an index-only run for each of these resources that has no reindex or
 * rebuild on its way, waiting or running. Any other run is not enough: one that
 * finds its derivatives describe the bytes skips Index, and keeps the old
 * chunks.
 */
async function queueReindex(
  pipeline: PipelineService,
  tx: Transaction,
  ids: string[]
): Promise<number> {
  if (ids.length === 0) return 0
  const onTheirWay = await resourcesWithReadyJobs(tx, PIPELINE_JOB_TYPE, ids, [
    { indexOnly: true },
    { rebuildOnly: true },
  ])
  const { enqueued } = await pipeline.enqueueMany(
    ids.filter((id) => !onTheirWay.has(id)).map((id) => ({ id, indexOnly: true })),
    // Nobody waits on any one of them (ADR-058 §6)
    { priority: 'low', tx }
  )
  return enqueued
}
