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
import { contentTypeOf, isUuid } from '@kukan/shared'
import type { JobQueue } from '@kukan/queue'
import type { SearchAdapter } from '@kukan/search-adapter'
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
 *
 * Asked for twice, a resource is indexed twice: its runs take turns under the
 * claim, and an index-only run is cheap, so nothing is kept to tell.
 */
export async function requestContentReindex(
  db: Database,
  search: SearchAdapter,
  queue: JobQueue
): Promise<{ enqueued: number; dropped: number }> {
  const dropped = await dropIndexedWithoutRow(
    (after, limit) => search.indexedContentResources(after, limit),
    async (ids, q) => (await reindexable(q, inArray(resource.id, ids))).map((id) => ({ id })),
    async (ids) => {
      for (const id of ids) {
        await search.deleteContent(id)
        if (isUuid(id)) await markContentUnindexed(db, { resourceId: id })
      }
    },
    (page) => page(db)
  )

  const pipeline = new PipelineService(db, queue)
  let enqueued = 0
  let failed = 0
  let after: string | undefined
  for (;;) {
    const rows = await db
      .select({ id: resource.id })
      .from(resource)
      .where(after ? gt(resource.id, after) : undefined)
      .orderBy(asc(resource.id))
      .limit(PAGE)
    if (rows.length > 0) {
      const ids = await reindexable(
        db,
        inArray(
          resource.id,
          rows.map((r) => r.id)
        )
      )
      const page = await pipeline.enqueueMany(
        ids.map((id) => ({ id, indexOnly: true })),
        // Nobody waits on any one of them (ADR-058 §6)
        { priority: 'low' }
      )
      enqueued += page.enqueued
      failed += page.failed.length
    }
    if (rows.length < PAGE) break
    after = rows.at(-1)!.id
  }
  // Thrown so the job runs again, rather than settling with resources left
  // under the old index and nothing to say so. Queued twice, the rest are
  // indexed twice, which is all a second run costs.
  if (failed > 0) throw new Error(`Could not queue ${failed} resources to index again`)
  return { enqueued, dropped }
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
