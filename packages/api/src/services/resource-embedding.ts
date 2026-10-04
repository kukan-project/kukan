/**
 * Marking resources whose vectors are stale, and asking for them to be built
 * (ADR-054).
 *
 * A resource's vector is built from its package's title and tags followed by
 * its own section, name, description and abstract. A write that changes any of
 * those marks the row (`embedding_due_at`) in the same statement, and the embed
 * job works through the marks — the shape of the search-document sync. The job
 * lives in the worker; this is what the writers need.
 */

import { and, eq, exists, inArray, isNotNull, sql, type SQL } from 'drizzle-orm'
import { type Database, packageTable, resource } from '@kukan/db'
import type { JobQueue } from '@kukan/queue'
import type { AIAdapter } from '@kukan/ai-adapter'
import { EMBED_JOB_TYPE, type Logger } from '@kukan/shared'

/**
 * How long a mark waits before the job that builds it runs.
 *
 * One waiting job stands for every mark (`unlessWaiting`), so the delay is
 * what collapses a burst of changes into one run: a bulk import's resources,
 * a pipeline run's abstract straight after the create, an editor saving three
 * times. Short enough that a single edit is searchable while the editor is
 * still looking at it.
 */
export const EMBED_DELAY_S = 60

/**
 * How long a mark has to have stood before the resource counts as work someone
 * has to start. Generously past {@link EMBED_DELAY_S}: the question is not "is
 * a job pending" but "will one arrive on its own", and a prompt shown in that
 * gap tells an administrator to fix something already fixing itself.
 */
export const EMBED_NOTICE_GRACE_MS = 15 * 60_000

/**
 * The `embedding_due_at` of an UPDATE that marks the row only when `changed` —
 * an expression over the row's values before the update, such as
 * `name IS DISTINCT FROM <new name>`. A write that changes nothing the vector
 * is built from leaves the mark as it was.
 */
export const embeddingDueIf = (changed: SQL) =>
  sql`CASE WHEN ${changed} THEN NOW() ELSE ${resource.embeddingDueAt} END`

/** Mark the vectors of a dataset's live resources stale: its title or tags changed */
export async function markPackageResourceEmbeddings(
  db: Pick<Database, 'update'>,
  packageId: string
): Promise<void> {
  await db
    .update(resource)
    .set({ embeddingDueAt: sql`NOW()` })
    .where(and(eq(resource.packageId, packageId), eq(resource.state, 'active')))
}

/** Mark the vector of every searchable resource stale: a regenerate, a model change */
export async function markAllResourceEmbeddings(db: Database): Promise<void> {
  await db
    .update(resource)
    .set({ embeddingDueAt: sql`NOW()` })
    .where(
      and(
        eq(resource.state, 'active'),
        exists(
          db
            .select({})
            .from(packageTable)
            .where(and(eq(packageTable.id, resource.packageId), eq(packageTable.state, 'active')))
        )
      )
    )
}

/**
 * Ask for the marked vectors to be built. Throws what the queue refused, for a
 * caller that wants it (the sweep). Nothing is asked for where embedding is
 * unavailable — the marks stay, and are what a site that turns it on later
 * builds from.
 */
export async function requestResourceEmbeds(
  queue: JobQueue,
  ai: AIAdapter,
  { delaySeconds = EMBED_DELAY_S }: { delaySeconds?: number } = {}
): Promise<void> {
  if (!ai.getEmbeddingInfo()) return
  await queue.enqueue(EMBED_JOB_TYPE, {}, { delaySeconds, unlessWaiting: true })
}

/**
 * {@link requestResourceEmbeds} after a write, when anything in `scope` is
 * marked — so a write that changed nothing the vector is built from queues
 * nothing. Best-effort: the mark is the record, and the sweep comes back for a
 * job the queue never heard of. Call it after the commit: a waiting job can
 * run before an open transaction commits, and would miss its marks.
 */
export async function enqueueResourceEmbedsIfDue(
  db: Database,
  deps: { queue: JobQueue; ai: AIAdapter; logger: Logger },
  scope: { resourceIds: string[] } | { packageId: string }
): Promise<void> {
  if (!deps.ai.getEmbeddingInfo()) return
  if ('resourceIds' in scope && scope.resourceIds.length === 0) return
  try {
    const [due] = await db
      .select({ id: resource.id })
      .from(resource)
      .where(
        and(
          'resourceIds' in scope
            ? inArray(resource.id, scope.resourceIds)
            : eq(resource.packageId, scope.packageId),
          isNotNull(resource.embeddingDueAt)
        )
      )
      .limit(1)
    if (due) await requestResourceEmbeds(deps.queue, deps.ai)
  } catch (err) {
    deps.logger.error({ err }, 'Embed enqueue failed; the sweep will retry')
  }
}
