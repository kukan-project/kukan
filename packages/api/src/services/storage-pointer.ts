/**
 * Moving a storage pointer, and parking what it replaced (ADR-043).
 *
 * See `orphaned_object` in the db schema for why replaced objects are parked
 * rather than deleted. Every mover follows the same shape: read the old key,
 * write the new one, and insert the old into `orphaned_object` — all in one
 * statement, so the row and the parking can never come apart. Raw SQL because
 * the query builder cannot express a data-modifying CTE.
 */

import { eq, sql } from 'drizzle-orm'
import type { Database, Transaction } from '@kukan/db'
import { orphanedObject } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { stillHeld, type ResourceClaim } from './pipeline-claim'

export interface PublishedContent {
  /**
   * Key this run's bytes are at, or null to leave the resource with no content
   * — a revert with nothing left to go back to. Emptying moves the same
   * pointer under the same condition, so it takes the same route rather than an
   * unconditional update of its own.
   */
  key: string | null
  /** Pointer value this run started from; the move is conditional on it. */
  previousKey: string | null
  hash: string | null
  size: number | null
  previousHash: string | null
  /**
   * The claim the writer holds, when it has one (ADR-044 §4).
   *
   * The live pointer is the second thing a run writes that outlives it — the
   * version row is the other — so like that row it moves only while the run
   * still holds the resource. Without it, stopping a run leaves the fetch it
   * was in the middle of free to publish its bytes afterwards, and "the content
   * is left as it was" stops being true of a stop.
   *
   * Omitted by the writers that have no claim to offer: an upload promotion
   * takes none (§6), and a resource with no pipeline row cannot be run against.
   */
  claim?: ResourceClaim | null
}

/**
 * Move a resource's pointer to `key` and record what that object holds.
 *
 * The move is conditional on the pointer still being where this run found it,
 * so a run whose content was superseded while it was fetching does not pull the
 * resource back to its own bytes — and, for a writer that holds a claim, on
 * still holding it, so a run that was stopped does not publish what it was
 * fetching when the stop arrived. Whichever object stops being pointed at is
 * parked — the one the move replaced when it applied, this run's own when it
 * did not, and nothing when this run had none. `lastModified` moves only on a
 * genuine content change.
 *
 * @returns whether this run's object became the live content.
 */
export async function publishLiveContent(
  db: Pick<Database, 'execute'>,
  resourceId: string,
  content: PublishedContent
): Promise<boolean> {
  const { key, previousKey, hash, size, claim } = content
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
        AND ${stillHeld(claim)}
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
      INSERT INTO orphaned_object (key, expires_at)
      SELECT key, ${PARKED_UNTIL} FROM orphan WHERE key IS NOT NULL
      ON CONFLICT (key) DO NOTHING
    ),
    -- This run's object is referenced now, so its write-ahead record has done
    -- its job (ADR-045). When the move did not apply, the record stays: the
    -- key is garbage, and the row above has already claimed it as such.
    released AS (
      DELETE FROM orphaned_object o USING outcome WHERE outcome.ok AND o.key = ${key}::text
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
    INSERT INTO orphaned_object (key, expires_at)
    SELECT key, ${PARKED_UNTIL} FROM cleared
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  `)
  return result.rows.length
}

/**
 * When the sweep may delete a key nothing points at any more: long enough for a
 * request that already resolved it to finish reading, across several Range
 * requests for a Parquet (ADR-043).
 */
export const PARKED_UNTIL = sql`NOW() + INTERVAL '1 hour'`

/**
 * When the sweep may delete a key whose object is about to be written: long
 * enough that the write has either finished — removing this record — or died
 * with it (ADR-045).
 *
 * The same hour as {@link PARKED_UNTIL} today, and stated separately because it
 * answers a different question. Tuning one for its own reason must not move the
 * other.
 */
export const RESERVED_UNTIL = sql`NOW() + INTERVAL '1 hour'`

/**
 * Record a key before its object exists, so a process that dies before anything
 * points at it still leaves a way back to the object (ADR-045).
 *
 * Removed by the statement that commits the pointer. A record left behind is
 * what the sweep reclaims — after checking that nothing references the key,
 * since a missed removal would otherwise cost live data.
 *
 * An existing record has its expiry pushed out rather than left alone: version
 * keys are derived from the version number, so a retried capture reserves the
 * same key again, and inheriting the first attempt's expiry would leave the
 * sweep free to delete the object while this write is still going.
 */
export async function reserveObject(
  db: Pick<Database | Transaction, 'insert'>,
  key: string
): Promise<void> {
  await db
    .insert(orphanedObject)
    .values({ key, expiresAt: RESERVED_UNTIL })
    .onConflictDoUpdate({ target: orphanedObject.key, set: { expiresAt: RESERVED_UNTIL } })
}

/**
 * Server-side copy of an object, recorded before it exists (ADR-045).
 *
 * The counterpart to the pipeline's `putObject`, for the writers that copy
 * rather than upload — version capture, the backfill, and the restore a purge
 * or a revert performs. Here so that reaching for a copy reaches for the
 * recording too; the three of them doing it by hand is three chances to forget,
 * and a fourth call site would have nothing to copy from.
 */
export async function copyObject(
  db: Pick<Database | Transaction, 'insert'>,
  storage: Pick<StorageAdapter, 'copy'>,
  sourceKey: string,
  destKey: string
): Promise<void> {
  await reserveObject(db, destKey)
  await storage.copy(sourceKey, destKey)
}

/**
 * Drop a write-ahead record because something references the key now.
 *
 * For the writers whose commit is a plain insert, with no orphan statement to
 * fold the removal into. A missed removal is not fatal — the sweep checks for a
 * reference before deleting anything (ADR-045 §3) — but it leaves a row that
 * gets re-examined every hour until something clears it.
 */
export async function releaseObject(
  db: Pick<Database | Transaction, 'delete'>,
  key: string
): Promise<void> {
  await db.delete(orphanedObject).where(eq(orphanedObject.key, key))
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
  await db.insert(orphanedObject).values({ key, expiresAt: PARKED_UNTIL }).onConflictDoNothing()
}
