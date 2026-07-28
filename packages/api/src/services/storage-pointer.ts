/**
 * Moving a storage pointer, and parking what it replaced (ADR-043).
 *
 * See `orphaned_object` in the db schema for why replaced objects are parked
 * rather than deleted. Every mover follows the same shape: read the old key,
 * write the new one, and insert the old into `orphaned_object` — all in one
 * statement, so the row and the parking can never come apart. Raw SQL because
 * the query builder cannot express a data-modifying CTE.
 */

import { sql } from 'drizzle-orm'
import type { Database, Transaction } from '@kukan/db'
import { orphanedObject } from '@kukan/db'

export interface PublishedContent {
  /** Key this run's bytes are at. */
  key: string
  /** Pointer value this run started from; the move is conditional on it. */
  previousKey: string | null
  hash: string
  size: number
  previousHash: string | null
}

/**
 * Move a resource's pointer to `key` and record what that object holds.
 *
 * The move is conditional on the pointer still being where this run found it,
 * so a run whose content was superseded while it was fetching does not pull the
 * resource back to its own bytes. Whichever object stops being pointed at is
 * parked — the one the move replaced when it applied, this run's own when it
 * did not. `lastModified` moves only on a genuine content change.
 *
 * @returns whether this run's object became the live content.
 */
export async function publishLiveContent(
  db: Pick<Database, 'execute'>,
  resourceId: string,
  content: PublishedContent
): Promise<boolean> {
  const { key, previousKey, hash, size } = content
  const changed = content.previousHash !== hash

  const result = await db.execute(sql`
    WITH published AS (
      UPDATE resource
      SET storage_key = ${key}::text,
          hash = ${hash}::text,
          size = ${size}::bigint
          ${changed ? sql`, last_modified = NOW()` : sql``}
      WHERE id = ${resourceId}::uuid
        AND storage_key IS NOT DISTINCT FROM ${previousKey}::text
      RETURNING id
    ),
    outcome AS (SELECT EXISTS (SELECT 1 FROM published) AS ok),
    orphan AS (
      SELECT ok,
             CASE WHEN ok THEN NULLIF(${previousKey}::text, ${key}::text) ELSE ${key}::text END
             AS key
      FROM outcome
    ),
    parked AS (
      INSERT INTO orphaned_object (key)
      SELECT key FROM orphan WHERE key IS NOT NULL
      ON CONFLICT (key) DO NOTHING
    )
    SELECT ok AS published FROM orphan
  `)

  return (result.rows[0] as { published: boolean } | undefined)?.published === true
}

/**
 * Park the objects of upload URLs that were never completed (ADR-043).
 *
 * `prepareForUpload` parks the pending key it replaces, so reissuing a URL
 * reclaims the old object; the last one has no such trigger. A client that asks
 * for a URL, writes the object and never calls `upload-complete` would
 * otherwise leave it named by `pending_storage_key` forever.
 *
 * @param ttlMs - how long a pending key is left alone. Bounds a slow upload
 *   rather than an in-flight read, so far longer than the orphan retention.
 */
export async function expirePendingUploads(
  db: Pick<Database, 'execute'>,
  ttlMs: number
): Promise<number> {
  const result = await db.execute(sql`
    WITH before AS (
      SELECT id, pending_storage_key FROM resource
      WHERE pending_storage_key IS NOT NULL
        AND pending_storage_key_at < NOW() - ${`${Math.trunc(ttlMs)} milliseconds`}::interval
      FOR UPDATE
    ),
    cleared AS (
      UPDATE resource r
      SET pending_storage_key = NULL, pending_storage_key_at = NULL, pending_metadata = NULL
      FROM before b WHERE r.id = b.id
      RETURNING b.pending_storage_key AS key
    )
    INSERT INTO orphaned_object (key)
    SELECT key FROM cleared
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  `)
  return result.rows.length
}

/**
 * Hand a key to the sweep. For the writers that have no pointer to move — an
 * upload URL reissued before the previous one was used. Null is ignored so
 * callers can pass a pointer that may be unset.
 */
export async function parkObject(
  db: Pick<Database | Transaction, 'insert'>,
  key: string | null | undefined
): Promise<void> {
  if (!key) return
  await db.insert(orphanedObject).values({ key }).onConflictDoNothing()
}
