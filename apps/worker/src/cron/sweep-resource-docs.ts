/**
 * Re-queue the search documents nobody heard about (ADR-053 §9.3).
 *
 * The write that makes a document stale cannot retry its own sync: the
 * Summarize step is best-effort and completes, and a retried edit changes
 * nothing to re-trigger on. Queuing the sync moved the retry to the queue,
 * which answers everything except a queue that never heard the request — so the
 * row is marked before the enqueue (ADR-045's shape), and this comes back for
 * whatever is still marked.
 *
 * Bounded per run rather than draining: a deployment enabling abstracts marks
 * every row at once, and the sweep is not the backfill.
 */
import { and, asc, eq, isNotNull, lt, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { packageTable, resource } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import { SYNC_RESOURCE_DOC_JOB_TYPE, type Logger } from '@kukan/shared'

/** How many to ask for in one pass */
const BATCH = 200

export async function sweepResourceDocs(
  db: Database,
  queue: QueueAdapter,
  log: Logger,
  /** Old enough that the job it was marked for has had its chance */
  minAgeMs = 10 * 60_000
): Promise<number> {
  const stale = await db
    .select({ id: resource.id })
    .from(resource)
    .innerJoin(packageTable, eq(resource.packageId, packageTable.id))
    .where(
      and(
        isNotNull(resource.docSyncDueAt),
        eq(resource.state, 'active'),
        // Only what the index holds: a draft's resources are indexed at publish
        // (ADR-039), so marking them would have the sweep ask for ever.
        eq(packageTable.state, 'active'),
        // A row marked seconds ago belongs to a job still in flight
        lt(resource.docSyncDueAt, sql`NOW() - ${`${minAgeMs} milliseconds`}::interval`)
      )
    )
    .orderBy(asc(resource.docSyncDueAt))
    .limit(BATCH)

  let queued = 0
  for (const { id } of stale) {
    try {
      await queue.enqueue(SYNC_RESOURCE_DOC_JOB_TYPE, { resourceId: id })
      queued++
    } catch (err) {
      // The next pass asks again — the row stays marked either way
      log.error({ err, resourceId: id }, 'Resource document sync re-enqueue failed')
      break
    }
  }
  if (queued > 0) log.info({ queued, found: stale.length }, 'Re-queued stale search documents')
  return queued
}
