/**
 * The row's record of what is in the content index.
 *
 * Its own module, and a small one: everything that deletes content documents
 * has to retract this, including paths that have no business importing the
 * search index's own helpers (or the service graph behind them).
 */

import { sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource } from '@kukan/db'

/** Whose record is being retracted. Spelled out because 'all' has to be asked
 *  for: an optional scope makes a forgotten argument mean the whole catalogue. */
export type ContentIndexScope = 'all' | { packageId: string } | { resourceId: string }

/**
 * Say on the rows that the content documents are gone.
 *
 * `resource_pipeline.metadata.contentIndexed` is the run's record that these
 * bytes are in the content index, and a run reads it to decide it has nothing
 * to index again. Whoever deletes the documents has to retract it, or the run
 * sent to rebuild them is the one that skips: a restored package would come
 * back with its resources unsearchable, and "reindex everything" would empty
 * the index and then decline to refill it.
 *
 * Retracting one that was true costs a derivation nobody needed; leaving one
 * that is false costs an index nobody notices is missing. So this is written
 * whenever the documents go, without asking whether a run is coming.
 */
export async function markContentUnindexed(db: Database, scope: ContentIndexScope): Promise<void> {
  const where =
    scope === 'all'
      ? sql``
      : 'packageId' in scope
        ? sql`WHERE resource_id IN (SELECT id FROM ${resource} WHERE package_id = ${scope.packageId})`
        : sql`WHERE resource_id = ${scope.resourceId}`
  await db.execute(sql`
    UPDATE resource_pipeline
    SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"contentIndexed": false}'::jsonb
    ${where}
  `)
}

/**
 * Raise the resource's content index mark: its content documents may disagree
 * with the row, and nothing is on its way to fix that — a delete whose cleanup
 * of the chunks failed, or is yet to run. The hourly sweep runs the resource
 * again or removes its chunks, whichever the row then calls for, and lowers it.
 *
 * Takes a transaction too, so a write can raise it in the same commit as the
 * change it records.
 */
export async function markContentIndexDue(
  db: Pick<Database, 'execute'>,
  scope: { resourceId: string }
): Promise<void> {
  await db.execute(
    sql`UPDATE ${resource} SET content_index_due_at = NOW() WHERE id = ${scope.resourceId}`
  )
}
