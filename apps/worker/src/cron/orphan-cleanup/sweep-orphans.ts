/**
 * Deletes storage objects nothing points at any more (ADR-043).
 *
 * Writers park keys rather than deleting them (see the `orphaned_object`
 * schema); this drains them once their retention has passed. Without it an
 * object would sit forever on a resource that is never processed again.
 */

import { sql, asc, inArray, lt } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { orphanedObject } from '@kukan/db'
import type { Logger } from '@kukan/shared'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { ORPHAN_CLEANUP_BATCH_SIZE, ORPHAN_RETENTION_MS } from '@/config'

export async function sweepOrphanedObjects(
  db: Database,
  storage: StorageAdapter,
  log: Logger
): Promise<{ scanned: number; deleted: number }> {
  // Oldest first, bounded per run: whatever this pass leaves is picked up an
  // hour later, so a backlog drains steadily rather than in one long chain.
  const due = await db
    .select({ key: orphanedObject.key })
    .from(orphanedObject)
    .where(
      lt(orphanedObject.orphanedAt, sql`NOW() - ${`${ORPHAN_RETENTION_MS} milliseconds`}::interval`)
    )
    .orderBy(asc(orphanedObject.orphanedAt))
    .limit(ORPHAN_CLEANUP_BATCH_SIZE)
  if (due.length === 0) return { scanned: 0, deleted: 0 }

  // Only keys the backend confirms are gone stop being tracked; one whose
  // delete failed stays parked so a later sweep retries it, rather than
  // becoming an object nothing knows about.
  const deleted = await storage.deleteMany(due.map((r) => r.key))
  if (deleted.length > 0) {
    await db.delete(orphanedObject).where(inArray(orphanedObject.key, deleted))
    log.info({ scanned: due.length, deleted: deleted.length }, 'Swept orphaned objects')
  }

  return { scanned: due.length, deleted: deleted.length }
}
