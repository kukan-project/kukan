/**
 * Re-queue the jobs for resource marks nobody heard about: stale search
 * documents (ADR-053 §9.3) and stale vectors (ADR-054).
 *
 * The write that makes a document or a vector stale cannot retry its own job:
 * the Summarize step is best-effort and completes, and a retried edit changes
 * nothing to re-trigger on. Queuing the job moved the retry to the queue,
 * which answers everything except a queue that never heard the request — so the
 * row is marked before the enqueue (ADR-045's shape), and this comes back for
 * whatever is still marked.
 *
 * One job however many are marked: each job works through every mark, not the
 * resource it was asked about, so all this has to establish is that one is due.
 */
import { and, isNotNull, lt, sql } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type { Database } from '@kukan/db'
import { resource } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'
import type { Logger } from '@kukan/shared'
import { requestResourceDocSync } from '@kukan/api/services/search-index'
import { requestResourceEmbeds } from '@kukan/api/services/resource-embedding'

/** Old enough that the job it was marked for has had its chance */
const MIN_AGE_MS = 10 * 60_000

/** Whether any row carries this mark, set longer ago than `minAgeMs` */
async function staleMark(db: Database, mark: PgColumn, minAgeMs: number): Promise<boolean> {
  const [stale] = await db
    .select({ id: resource.id })
    .from(resource)
    .where(
      and(
        isNotNull(mark),
        // A row marked seconds ago belongs to a job still in flight
        lt(mark, sql`NOW() - ${`${minAgeMs} milliseconds`}::interval`)
      )
    )
    .limit(1)
  return stale !== undefined
}

/** Whether a sync was asked for */
export async function sweepResourceDocs(
  db: Database,
  queue: QueueAdapter,
  log: Logger,
  minAgeMs = MIN_AGE_MS
): Promise<boolean> {
  // Any mark, whatever the row: the sync writes, removes or only clears
  if (!(await staleMark(db, resource.docSyncDueAt, minAgeMs))) return false
  // Thrown on to the cron's own logging: the next pass asks again, since the
  // rows stay marked either way
  await requestResourceDocSync(queue)
  log.info('Asked for a sync of stale search documents')
  return true
}

/** Whether an embed was asked for. Never where embedding is unavailable. */
export async function sweepResourceEmbeds(
  db: Database,
  queue: QueueAdapter,
  ai: AIAdapter,
  log: Logger,
  minAgeMs = MIN_AGE_MS
): Promise<boolean> {
  if (!ai.getEmbeddingInfo()) return false
  // Any mark, as above: the job builds, clears or only unmarks
  if (!(await staleMark(db, resource.embeddingDueAt, minAgeMs))) return false
  // Without the delay: these marks have waited long enough
  await requestResourceEmbeds(queue, ai, { delaySeconds: 0 })
  log.info('Asked for the stale vectors to be built')
  return true
}
