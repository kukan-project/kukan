/**
 * Content indexed under a larger chunk size than the one in force.
 *
 * A chunk's size is fixed when the worker writes it, so lowering
 * MAX_CONTENT_CHUNK_SIZE reaches a running deployment only as each resource is
 * indexed again. Nothing else rewrites a resource whose bytes have not changed,
 * and no setting tells an administrator that a run is owed — so the index
 * itself is asked, and the dashboard says what it found.
 */

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { type Database, type Transaction, job, packageTable, resource } from '@kukan/db'
import { MAX_CONTENT_CHUNK_SIZE, PIPELINE_JOB_TYPE, inTurn, isUuid } from '@kukan/shared'
import type { JobQueue } from '@kukan/queue'
import type { SearchAdapter } from '@kukan/search-adapter'
import { CONTENT_RECHUNK_LOCK, lockInTransaction } from '../concurrency/advisory-lock'
import { PipelineService } from '../pipeline/pipeline-service'
import { markContentUnindexed } from './content-index-record'
import { dropIndexedWithoutRow } from './search-index'

/**
 * Index those resources again, from the object each already holds (ADR-044 §4).
 *
 * The content index is not emptied first, as the full rebuild does: each run
 * replaces its own resource's chunks, so search keeps the old ones until then.
 *
 * A resource with a rebuild already on its way — waiting or running — is left
 * to it. Any other run is not enough: one that finds its derivatives describe
 * the bytes skips Index, and keeps the old chunks. A page is read and queued in
 * one transaction under one lock, so two passes cannot both find a resource
 * without a rebuild and queue it twice. The transaction is the only connection
 * a pass holds: a worker with a pool of one still gets through.
 *
 * Content no run would replace is dropped instead, or the notice would count it
 * for good: a resource that is gone or deleted, or one outside a published
 * dataset — Index writes nothing for those (ADR-039). So is a resource with no
 * stored object, which only a fetch could rebuild, and this promises none.
 */
export async function requestContentRechunk(
  db: Database,
  search: SearchAdapter,
  queue: JobQueue
): Promise<{ enqueued: number; dropped: number }> {
  const pipeline = new PipelineService(db, queue)
  let enqueued = 0
  const dropped = await dropIndexedWithoutRow(
    (after, limit) =>
      search.indexedContentResources(after, limit, { chunkedAbove: MAX_CONTENT_CHUNK_SIZE }),
    // The rows a run would rebuild — queued on the way, in the page's transaction
    async (ids, q) => {
      const rows = await q
        .select({ id: resource.id })
        .from(resource)
        .innerJoin(packageTable, eq(resource.packageId, packageTable.id))
        .where(
          and(
            inArray(resource.id, ids),
            eq(resource.state, 'active'),
            eq(packageTable.state, 'active'),
            isNotNull(resource.storageKey)
          )
        )
      const rebuilding = await rebuildsOnTheirWay(
        q,
        rows.map((r) => r.id)
      )
      const page = await pipeline.enqueueMany(
        rows.filter((r) => !rebuilding.has(r.id)).map((r) => ({ id: r.id, rebuildOnly: true })),
        // Nobody waits on any one of them (ADR-058 §6)
        { priority: 'low', tx: q as Transaction }
      )
      enqueued += page.enqueued
      return rows
    },
    async (ids, q) => {
      for (const id of ids) {
        await search.deleteContent(id)
        if (isUuid(id)) await markContentUnindexed(q, { resourceId: id })
      }
    },
    (page) =>
      // In this process, in turn before a connection is taken (ADR-058 §7)
      inTurn(CONTENT_RECHUNK_LOCK, () =>
        queue.transaction(db, async (tx) => {
          await lockInTransaction(tx, CONTENT_RECHUNK_LOCK, '')
          return page(tx)
        })
      )
  )
  return { enqueued, dropped }
}

/** Of these resources, those with a rebuild run waiting or running */
async function rebuildsOnTheirWay(q: Database | Transaction, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const resourceId = sql<string>`${job.payload} ->> 'resourceId'`
  const rows = await q
    .select({ resourceId })
    .from(job)
    .where(
      and(
        eq(job.type, PIPELINE_JOB_TYPE),
        eq(job.state, 'ready'),
        inArray(resourceId, ids),
        sql`${job.payload} @> '{"rebuildOnly": true}'::jsonb`
      )
    )
  return new Set(rows.map((r) => r.resourceId))
}
