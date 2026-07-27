/**
 * Sweeps preview objects a newer pipeline run replaced (ADR-043).
 *
 * The run that replaced a preview parks its key on the pipeline row rather than
 * deleting it, so in-flight readers are not cut off. That alone would leave the
 * object forever on a resource which is never processed again — an upload that
 * is replaced once, then left alone. This job drains the parked keys on a timer.
 */

import { sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import type { Logger } from '@kukan/shared'
import type { StorageAdapter } from '@kukan/storage-adapter'
import {
  deletePreviews,
  dueForDeletion,
  pendingPreviewsOf,
} from '../../pipeline/superseded-previews'
import pLimit from 'p-limit'
import {
  PREVIEW_CLEANUP_BATCH_SIZE,
  PREVIEW_DELETE_CONCURRENCY,
  PREVIEW_SWEEP_ROW_CONCURRENCY,
} from '@/config'

/**
 * Pipelines carrying at least one parked preview key.
 *
 * Bounded per run like the health check: whatever this pass leaves is still
 * parked and picked up an hour later, so a backlog drains steadily instead of
 * one sweep holding a connection and a long delete chain.
 */
const PARKED_PREVIEWS_QUERY = sql`
  SELECT id, metadata FROM resource_pipeline
  WHERE jsonb_array_length(COALESCE(metadata -> 'supersededPreviews', '[]'::jsonb)) > 0
  ORDER BY updated ASC
  LIMIT ${PREVIEW_CLEANUP_BATCH_SIZE}
`

export async function sweepSupersededPreviews(
  db: Database,
  storage: StorageAdapter,
  log: Logger
): Promise<{ scanned: number; deleted: number }> {
  const result = await db.execute(PARKED_PREVIEWS_QUERY)
  const rows = result.rows as unknown as { id: string; metadata: unknown }[]

  const now = Date.now()
  let deleted = 0
  const limit = pLimit(PREVIEW_SWEEP_ROW_CONCURRENCY)
  // One budget for the whole sweep: a limiter per row would multiply by the row
  // concurrency above rather than bound the burst.
  const deleteLimit = pLimit(PREVIEW_DELETE_CONCURRENCY)
  await Promise.all(
    rows.map((row) =>
      limit(async () => {
        const removed = await deletePreviews(
          dueForDeletion(pendingPreviewsOf(row.metadata), now),
          (key) => deleteLimit(() => storage.delete(key))
        )
        if (removed.length === 0) return

        deleted += removed.length
        // Filters the list as it stands *now* rather than writing back the array
        // this job read: a pipeline run may have parked another key in between,
        // and overwriting would leave that object with nothing tracking it.
        await db.execute(sql`
          UPDATE resource_pipeline
          SET metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{supersededPreviews}',
            COALESCE(
              (
                SELECT jsonb_agg(e)
                FROM jsonb_array_elements(
                  COALESCE(metadata -> 'supersededPreviews', '[]'::jsonb)
                ) e
                WHERE NOT (
                  e ->> 'key' IN (
                    SELECT jsonb_array_elements_text(${JSON.stringify(removed)}::jsonb)
                  )
                )
              ),
              '[]'::jsonb
            )
          )
          WHERE id = ${row.id}::uuid
        `)
      })
    )
  )

  if (deleted > 0) log.info({ scanned: rows.length, deleted }, 'Swept superseded previews')
  return { scanned: rows.length, deleted }
}
