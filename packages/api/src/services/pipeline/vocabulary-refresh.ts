/**
 * KUKAN — tables read against another vocabulary, read again (ADR-073 §決定 4)
 *
 * A profile records the registry state its columns' vocabulary was worked out
 * under. Enabling or disabling a pack, or a release that changes a pack or the
 * rules, changes the state, and a profile made under the old one says what the
 * old one said until its table is interpreted again. This finds those tables
 * and queues each a rebuild.
 */

import { and, asc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { packageTable, resource, resourcePipeline } from '@kukan/db'
import type { JobQueue } from '@kukan/queue'
import { PipelineService } from './pipeline-service'

const PAGE = 1_000

/**
 * Queue a rebuild of every table whose profile was worked out under a state
 * other than `state`.
 *
 * A rebuild interprets the table again from the object it already holds
 * (ADR-044 §4): no route reads a profile's columns again from the preview
 * alone, and a state changes seldom — a site's setting, or a release.
 *
 * @param state - the current registry state, or null where the site enables
 *   no pack: a profile then holds no vocabulary, and one that does is out of date.
 * @returns the rebuilds queued. Thrown on any refusal, so the job runs again;
 *   asked twice, a table is interpreted twice, which is all it costs.
 */
export async function requestVocabularyRefresh(
  db: Database,
  queue: JobQueue,
  state: string | null
): Promise<{ enqueued: number }> {
  const recorded = sql`${resourcePipeline.profile} ->> 'registry'`
  const stale =
    state === null ? sql`${recorded} IS NOT NULL` : sql`${recorded} IS DISTINCT FROM ${state}`
  const pipeline = new PipelineService(db, queue)
  let enqueued = 0
  let failed = 0
  let after: string | undefined
  for (;;) {
    // As a bulk rebuild picks them (`enqueueAll`): live resources of live or
    // draft datasets, with an object to rebuild from — and a table profiled
    const rows = await db
      .select({ id: resource.id })
      .from(resource)
      .innerJoin(packageTable, eq(resource.packageId, packageTable.id))
      .innerJoin(resourcePipeline, eq(resourcePipeline.resourceId, resource.id))
      .where(
        and(
          after ? gt(resource.id, after) : undefined,
          eq(resource.state, 'active'),
          inArray(packageTable.state, ['active', 'draft']),
          isNotNull(resource.storageKey),
          sql`jsonb_array_length(${resourcePipeline.profile} -> 'columns') > 0`,
          stale
        )
      )
      .orderBy(asc(resource.id))
      .limit(PAGE)
    if (rows.length > 0) {
      const page = await pipeline.enqueueMany(
        rows.map(({ id }) => ({ id, rebuildOnly: true })),
        // Nobody waits on any one of them (ADR-058 §6)
        { priority: 'low' }
      )
      enqueued += page.enqueued
      failed += page.failed.length
    }
    if (rows.length < PAGE) break
    after = rows.at(-1)!.id
  }
  if (failed > 0) throw new Error(`Could not queue ${failed} tables to read again`)
  return { enqueued }
}
