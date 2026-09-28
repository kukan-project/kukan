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
 * One job however many are marked: the sync works through every mark, not the
 * resource it was asked about, so all this has to establish is that one is due.
 */
import { and, isNotNull, lt, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { Logger } from '@kukan/shared'
import { requestResourceDocSync } from '@kukan/api/services/search-index'

/** Whether a sync was asked for */
export async function sweepResourceDocs(
  db: Database,
  queue: QueueAdapter,
  log: Logger,
  /** Old enough that the job it was marked for has had its chance */
  minAgeMs = 10 * 60_000
): Promise<boolean> {
  // Any mark, whatever the row: the sync writes, removes or only clears
  const [stale] = await db
    .select({ id: resource.id })
    .from(resource)
    .where(
      and(
        isNotNull(resource.docSyncDueAt),
        // A row marked seconds ago belongs to a job still in flight
        lt(resource.docSyncDueAt, sql`NOW() - ${`${minAgeMs} milliseconds`}::interval`)
      )
    )
    .limit(1)
  if (!stale) return false
  // Thrown on to the cron's own logging: the next pass asks again, since the
  // rows stay marked either way
  await requestResourceDocSync(queue)
  log.info('Asked for a sync of stale search documents')
  return true
}
