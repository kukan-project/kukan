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
  // Rerun on a lost instance: the task-role credential rotates about every
  // seven hours, and the tick that lands on it used to fail whole and log an
  // error, with the sweep put off to the next one.
  let rerun = false
  const deleted = await withLakeSession(
    lake,
    (session, attempt) => {
      rerun = attempt > 1
      return deleteOrphanedFiles(session, olderThan)
    },
    { rerunIfLost: true }
  )

  // Logged with the paths: an orphan means a run died mid-write, so the count
  // going up is worth noticing rather than absorbing silently. After a rerun
  // the count is only the second pass's — what the first deleted before the
  // loss is unknowable — so that tick is logged whatever the count, as the
  // one whose orphans went unobserved.
  const summary = { deleted: deleted.length, paths: deleted.slice(0, 10) }
  if (rerun) {
    log.warn(summary, 'Swept DuckLake orphans on a rebuilt instance; the first pass is uncounted')
  } else if (deleted.length > 0) {
    log.info(summary, 'Swept DuckLake orphans')
  }
  return { deleted: deleted.length }
}
