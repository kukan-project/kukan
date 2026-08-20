/**
 * Moving a storage pointer, and parking what it replaced (ADR-043).
 *
 * See `orphaned_object` in the db schema for why replaced objects are parked
 * rather than deleted. Every mover follows the same shape: read the old key,
 * write the new one, and insert the old into `orphaned_object` — all in one
 * statement, so the row and the parking can never come apart. Raw SQL because
 * the query builder cannot express a data-modifying CTE.
 */

import { sql, type SQL } from 'drizzle-orm'
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
   * Format to put back on the resource, for the writers that are restoring a
   * version rather than publishing new bytes (ADR-046 §6).
   *
   * A version is those bytes read under that format, so restoring one restores
   * both — otherwise the resource describes recovered content by a label that
   * was never applied to it, and the version gate, which compares the label
   * against the highest active version's, sees a difference that is not there
   * and files the same bytes again under a new number.
   *
   * In this statement rather than a second one for the same reason the hash is:
   * the move is a compare-and-swap, and a value written beside it can land on a
   * resource the move did not apply to.
   *
   * Omitted by Fetch and by an upload promotion, which are publishing content
   * the resource's own label already describes.
   */
  format?: string | null
  /**
   * Key columns to put back on the resource, for the same writers and the same
   * reason as {@link PublishedContent.format} (spec §6.4).
   *
   * A version is those bytes read that way, and the key is the other half of
   * "that way": restoring the content and leaving the setting describes
   * recovered content by a key never applied to it, and the version gate — which
   * compares the setting against the highest active version's frozen list —
   * files the same bytes again under a new number.
   *
   * Written here rather than beside, so it lands only where the move applied,
   * and *before* the row a revert then inserts: that insert reads the resource
   * for its own frozen copy (`insertVersionIfHeld`), so the two agree by
   * construction rather than by both being handed the same value.
   *
   * Null takes the key off. Omitted by the writers publishing content the
   * resource's own setting already describes.
   */
  keyColumns?: string[] | null
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
 * The settled key as `column_settings` holds it — set, or taken off.
 *
 * The one place the shape `@kukan/shared` defines is spelled in SQL. Empty
 * normalizes to absent here, because "no key" has one spelling (spec §6.2) and a
 * second one would reach every reader.
 */
function keySetting(keyColumns: string[] | null | undefined) {
  return keyColumns?.length
    ? sql`jsonb_set(column_settings, '{primaryKey}', ${JSON.stringify(keyColumns)}::jsonb, true)`
    : sql`column_settings - 'primaryKey'`
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
 * Except an object a version names. Live points straight at the object its
 * version was made from (ADR-043 §1), so the key a move steps off is usually
 * the previous version's file, and parking it would put the canonical copy of
 * that version on the sweep's list. The sweep would spare it, finding a pointer
 * — but that leaves the survival of a canonical file resting on the reference
 * check being exhaustive. Cheaper not to ask.
 *
 * A purged version does not count: a tombstone keeps its key only because the
 * column cannot be null, and the object it named is already gone.
 *
 * When the move applies, this run's object is referenced and its write-ahead
 * record has done its job, so the record goes in the same statement (ADR-045).
 * When it does not, the record stays: the key is garbage, and the row parked
 * above has already claimed it as such.
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
          size = ${size}::bigint,
          -- Every move is a new generation.
          content_revision = gen_random_uuid()
          ${'format' in content ? sql`, format = ${content.format}::varchar` : sql``}
          ${'keyColumns' in content ? sql`, column_settings = ${keySetting(content.keyColumns)}` : sql``}
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
      SELECT key, ${PARKED_UNTIL} FROM orphan
      WHERE key IS NOT NULL
        -- A version's object is not garbage (see above).
        AND NOT ${ownedByVersion(sql`orphan.key`)}
      ON CONFLICT (key) DO NOTHING
    ),
    -- The write-ahead record has done its job (see above).
    released AS (
      DELETE FROM orphaned_object o USING outcome WHERE outcome.ok AND o.key = ${key}::text
    )
    SELECT ok AS published FROM orphan
  `)

  return (result.rows[0] as { published: boolean } | undefined)?.published === true
}

/** What a resource is left saying when its only upload never arrived. */
export const UPLOAD_NEVER_COMPLETED = 'The upload was never completed'

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
 * Say so on the resources whose upload never arrived.
 *
 * An upload leaves a resource row before it leaves a file: the row is created,
 * then a URL is asked for, then the bytes are written. Give up anywhere along
 * that and the row stays — listed, undownloadable, answering every reprocess
 * with a failure, and saying nothing about any of it. Deleting was the only way
 * out, and nothing said that either.
 *
 * Asked of the resource rather than of the sweep that expires upload URLs, which
 * is where this began. That sweep only ever sees rows that got as far as asking
 * for a URL; a client that dies between creating the row and asking would never
 * be seen by it at all. What the state is — an upload-type resource, no object,
 * nothing on its way — is the whole of the question, and asking it directly also
 * reaches everything that reached this state before there was anything to ask.
 *
 * Left alone: a resource any version has held — emptied rather than unfilled,
 * whether by a revert or by purging the last one (ADR-044 §4, ADR-046 §3).
 * Tombstones count, unlike the ownership question elsewhere in this file: that
 * one asks who owns bytes, this one whether content ever arrived, and a purged
 * version records that it did. Also left alone: one already carrying this, so an
 * hourly pass does not keep rewriting the same row; one a run or a job holds,
 * being mid-sentence about it; and a deleted one, since deleting was the way out
 * this signposts.
 *
 * @param olderThanMs - how long a resource may sit empty before this is said of
 *   it. The same window the upload URL gets, so nothing is called abandoned
 *   while its upload could still land.
 */
export async function markUploadsThatNeverArrived(
  db: Pick<Database, 'execute'>,
  olderThanMs: number
): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO resource_pipeline (resource_id, status, error)
    SELECT r.id, 'error', ${UPLOAD_NEVER_COMPLETED}
    FROM resource r
    WHERE r.url_type = 'upload'
      AND r.storage_key IS NULL
      AND r.pending_storage_key IS NULL
      AND r.state <> 'deleted'
      AND r.created < NOW() - ${`${Math.trunc(olderThanMs)} milliseconds`}::interval
      -- Tombstones included (see above).
      AND NOT EXISTS (SELECT 1 FROM resource_version v WHERE v.resource_id = r.id)
      AND NOT EXISTS (
        SELECT 1 FROM resource_pipeline p
        WHERE p.resource_id = r.id
          AND (p.claim_owner IS NOT NULL OR p.error = ${UPLOAD_NEVER_COMPLETED})
      )
    ON CONFLICT (resource_id) DO UPDATE
      SET status = 'error', error = EXCLUDED.error, updated = NOW()
      WHERE resource_pipeline.claim_owner IS NULL
    RETURNING resource_id
  `)
  return result.rows.length
}

/**
 * SQL condition: some version that is not a tombstone owns this object.
 *
 * A version owns the bytes it names — the purge destroys them (ADR-046 §3) — so
 * nothing else may park or delete an object while a version still names it. Now
 * that live points straight at the object its version was made from (ADR-043
 * §1), that is the ordinary case rather than a corner: the key a pointer steps
 * off is usually the previous version's file.
 *
 * A purged row does not count. It keeps its key because the column cannot be
 * null, and the object it named is already gone.
 */
export function ownedByVersion(key: SQL) {
  return sql`EXISTS (
    SELECT 1 FROM resource_version v WHERE v.storage_key = ${key} AND v.state <> 'purged'
  )`
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
 * keys are derived from the version number, so a retried create reserves the
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
 * The counterpart to the pipeline's `putObject`, for the one writer that still
 * copies: creating a version out of an object another version already owns
 * (ADR-043 §1). Everything else names the object it was given. Here so that
 * reaching for a copy reaches for the recording too — a caller doing it by hand
 * is a chance to forget, and the next one added would have nothing to copy
 * from.
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
