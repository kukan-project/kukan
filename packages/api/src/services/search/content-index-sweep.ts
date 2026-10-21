/**
 * Bringing the content index back in line with the rows it is owed to.
 *
 * A resource's content index mark (`content_index_due_at`) records that its
 * content documents may disagree with it and nothing is on its way to fix that:
 * a run whose index write met the search backend down, a delete whose cleanup
 * failed. The queue cannot retry either — the run's job succeeded, and the
 * delete was a request that has already been answered — so the hourly sweep
 * comes back for whatever is still marked.
 */

import { and, asc, eq, inArray, isNotNull, lt, notExists, sql } from 'drizzle-orm'
import { type Database, resource } from '@kukan/db'
import { PIPELINE_JOB_TYPE } from '@kukan/shared'
import { readyJobsFor, type JobQueue } from '@kukan/queue'
import type { SearchAdapter } from '@kukan/search-adapter'
import { PipelineService } from '../pipeline/pipeline-service'
import { withResourceClaims } from '../pipeline/pipeline-claim'
import { markContentUnindexed } from './content-index-record'
import { reindexable } from './content-reindex'

/** The most marks one pass takes; the rest wait for the next */
export const CONTENT_INDEX_SWEEP_LIMIT = 500

export interface ContentIndexSweep {
  /** Runs queued to index a resource again; each lowers its mark */
  queued: number
  /** Runs the queue refused; their marks stay for the next pass */
  failed: number
  /** Resources whose content documents were removed, and their marks lowered */
  removed: number
  /** Removals left for the next pass: a run held the resource */
  held: number
}

/**
 * Act on the marks set longer ago than `minAgeMs`, oldest first.
 *
 * A resource a run would index again gets an index-only run (ADR-021), which
 * lowers the mark when it indexes. One with a run already waiting or running is
 * left to it. Every other resource — deleted, in a dataset that is deleted or a
 * draft, of a format the index takes nothing from, with no object to read — has
 * its content documents removed, which is what its next run would write, and
 * its mark lowered if it is still the one read.
 *
 * The removal is made under the resource's claim, and decided again there. A
 * run starting meanwhile — a dataset being published — writes its content after
 * the removal rather than having it removed from under it.
 *
 * Throws when the index refuses a removal, leaving that mark and the ones after
 * it for the next pass: with the backend down, every one of them would fail.
 */
export async function sweepContentIndexMarks(
  db: Database,
  search: SearchAdapter,
  queue: JobQueue,
  opts: { minAgeMs: number; limit?: number }
): Promise<ContentIndexSweep> {
  const marked = await db
    .select({ id: resource.id, dueAt: sql<string>`${resource.contentIndexDueAt}::text` })
    .from(resource)
    .where(
      and(
        isNotNull(resource.contentIndexDueAt),
        // A mark raised seconds ago may belong to a run or a request in flight
        lt(resource.contentIndexDueAt, sql`NOW() - ${`${opts.minAgeMs} milliseconds`}::interval`),
        notExists(readyJobsFor(db, PIPELINE_JOB_TYPE, sql`${resource.id}::text`))
      )
    )
    .orderBy(asc(resource.contentIndexDueAt))
    .limit(opts.limit ?? CONTENT_INDEX_SWEEP_LIMIT)
  if (marked.length === 0) return { queued: 0, failed: 0, removed: 0, held: 0 }

  const runnable = new Set(
    await reindexable(
      db,
      inArray(
        resource.id,
        marked.map((r) => r.id)
      )
    )
  )
  const toRun = marked.filter((r) => runnable.has(r.id))
  // Stamped afresh before the run reads it: a run that never reaches the Index
  // step (its job dies earlier, every time) then waits at the back, rather
  // than holding the front of every pass
  if (toRun.length > 0) {
    await db
      .update(resource)
      .set({ contentIndexDueAt: sql`NOW()` })
      .where(
        and(
          inArray(
            resource.id,
            toRun.map((r) => r.id)
          ),
          isNotNull(resource.contentIndexDueAt)
        )
      )
  }
  const { enqueued, failed } = await new PipelineService(db, queue).enqueueMany(
    toRun.map((r) => ({ id: r.id, indexOnly: true })),
    // Nobody is waiting on any one of them (ADR-058 §6)
    { priority: 'low' }
  )

  let removed = 0
  let held = 0
  for (const row of marked.filter((r) => !runnable.has(r.id))) {
    const outcome = await withResourceClaims(db, [row.id], async () => {
      // Asked again under the claim: a dataset published since the read has
      // its runs queued, and they index what this would remove — the mark is
      // theirs to lower. One published from here on waits for the claim
      if ((await reindexable(db, eq(resource.id, row.id))).length > 0) return
      await search.deleteContent(row.id)
      await markContentUnindexed(db, { resourceId: row.id })
      await lowerContentIndexMark(db, row.id, row.dueAt)
      removed++
    })
    if (outcome.status === 'held') held++
  }
  return { queued: enqueued, failed: failed.length, removed, held }
}

/** Lower the mark read, and only that one: a newer mark has work of its own */
async function lowerContentIndexMark(db: Database, resourceId: string, read: string) {
  await db
    .update(resource)
    .set({ contentIndexDueAt: null })
    .where(
      and(eq(resource.id, resourceId), eq(resource.contentIndexDueAt, sql`${read}::timestamptz`))
    )
}
