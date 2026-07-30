/**
 * Deletes storage objects nothing points at any more (ADR-043, ADR-045).
 *
 * Two kinds of key reach this ledger: one a writer parked because it replaced
 * the object, and one a writer recorded before creating the object so a crash
 * could not strand it. They share a table because they reduce to the same
 * question — does any pointer reference this object now?
 *
 * Asking it is what makes the second kind safe. A record whose removal was
 * missed would otherwise have this delete live data; instead the record goes
 * and the object stays.
 */

import { sql, asc, inArray, lt } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { orphanedObject } from '@kukan/db'
import type { Logger } from '@kukan/shared'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { ORPHAN_CLEANUP_BATCH_SIZE } from '@/config'

/**
 * Which of these keys some pointer still names.
 *
 * The set of sources has to be exhaustive: one missing from here is one whose
 * object this sweep would delete out from under its row. There is no way to
 * derive the list, which is the standing cost of asking the question — bounded
 * only by never asking it about anything a writer did not nominate first
 * (ADR-045).
 */
function referenced(keys: string[]) {
  return sql`
    SELECT o.key FROM unnest(${sql.param(keys)}::text[]) AS o(key)
    WHERE EXISTS (SELECT 1 FROM resource r
                  WHERE r.storage_key = o.key OR r.pending_storage_key = o.key)
       OR EXISTS (SELECT 1 FROM resource_version rv WHERE rv.storage_key = o.key)
       OR EXISTS (SELECT 1 FROM resource_pipeline rp
                  WHERE rp.preview_key = o.key OR rp.metadata ->> 'textHeadKey' = o.key)
  `
}

export async function sweepOrphanedObjects(
  db: Database,
  storage: StorageAdapter,
  log: Logger
): Promise<{ scanned: number; deleted: number; stillReferenced: number }> {
  // Oldest first, bounded per run: whatever this pass leaves is picked up an
  // hour later, so a backlog drains steadily rather than in one long chain.
  const due = await db
    .select({ key: orphanedObject.key })
    .from(orphanedObject)
    .where(lt(orphanedObject.expiresAt, sql`NOW()`))
    .orderBy(asc(orphanedObject.expiresAt))
    .limit(ORPHAN_CLEANUP_BATCH_SIZE)
  if (due.length === 0) return { scanned: 0, deleted: 0, stillReferenced: 0 }

  const keys = due.map((r) => r.key)
  const result = await db.execute(referenced(keys))
  const live = new Set((result.rows as unknown as { key: string }[]).map((r) => r.key))

  const orphans = keys.filter((k) => !live.has(k))
  // Only keys the backend confirms are gone stop being tracked; one whose
  // delete failed stays parked so a later sweep retries it, rather than
  // becoming an object nothing knows about.
  const deleted = orphans.length > 0 ? await storage.deleteMany(orphans) : []

  // Two reasons to stop tracking a key, one statement: its object is gone, or
  // something references it after all — in which case the record is the
  // leftover and the object stays. Left in place it would be re-examined every
  // hour for good.
  const untrack = [...deleted, ...live]
  if (untrack.length > 0) {
    await db.delete(orphanedObject).where(inArray(orphanedObject.key, untrack))
  }

  if (deleted.length > 0 || live.size > 0) {
    log.info(
      { scanned: due.length, deleted: deleted.length, stillReferenced: live.size },
      'Swept orphaned objects'
    )
  }

  return { scanned: due.length, deleted: deleted.length, stillReferenced: live.size }
}
