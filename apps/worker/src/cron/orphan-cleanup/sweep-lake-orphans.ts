/**
 * Deletes DuckLake data files the catalog never tracked (ADR-043 layer 2).
 *
 * The sibling sweep drains `orphaned_object`, which only holds keys a writer
 * parked deliberately. These are the ones nobody got to park: DuckLake writes
 * a Parquet before committing it, so a process that dies in between leaves a
 * file the catalog has no record of. Expiry and cleanup both work from the
 * catalog, so neither will ever see it.
 */
import { deleteOrphanedFiles, withLakeSession } from '@kukan/lake'
import type { LakeConfig } from '@kukan/lake'
import type { Logger } from '@kukan/shared'
import { LAKE_ORPHAN_RETENTION_MS } from '@/config'

export async function sweepLakeOrphans(
  lake: LakeConfig | undefined,
  log: Logger
): Promise<{ deleted: number }> {
  if (!lake) return { deleted: 0 }

  // Anything younger is treated as a write still in progress, not an orphan.
  const olderThan = new Date(Date.now() - LAKE_ORPHAN_RETENTION_MS)
  const deleted = await withLakeSession(lake, (session) => deleteOrphanedFiles(session, olderThan))

  // Logged with the paths: an orphan means a run died mid-write, so the count
  // going up is worth noticing rather than absorbing silently.
  if (deleted.length > 0) {
    log.info({ deleted: deleted.length, paths: deleted.slice(0, 10) }, 'Swept DuckLake orphans')
  }
  return { deleted: deleted.length }
}
