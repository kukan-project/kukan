/**
 * DuckLake snapshot reclamation (ADR-043 §5, layer 2).
 *
 * **Reclaims capacity; does not erase.** What puts a purged version out of
 * reach is nulling its `ducklake_snapshot_id`, not anything here — this frees
 * whatever the retained set no longer holds, and the purge completes whether or
 * not it reaches the bytes (spec §9).
 *
 * Under ii-a it happens to reach all of them: a keyless load replaces the whole
 * table, so a version's files are referenced by that version alone and expiring
 * its snapshot leaves them unreferenced. **Neither ii-b's keyed load nor a
 * catalog holding more than one table keeps that true** — rows from several
 * versions share a file, and a snapshot retained for another resource holds
 * this resource's files (spec §9.2). No file is ever rewritten either way.
 */
import type { LakeSession } from './connection'

export interface ReclaimResult {
  expired: number
  filesDeleted: number
}

/**
 * Expire every snapshot outside `retain` and delete the files that frees.
 *
 * Snapshot ids are catalog-wide, so the caller must pass the retained set for
 * the *whole* catalog — every version of every resource — not just the
 * resource being purged. A time-based `older_than` cannot express that: the
 * ids are one shared sequence, so an age cutoff sweeps up the snapshots of
 * resources that simply have not changed lately.
 *
 * The newest snapshot is always kept. It is what the tables currently read as,
 * and a purge that rolled a table back has just created one that no version
 * row points at yet.
 */
export async function reclaimUnreferencedSnapshots(
  session: LakeSession,
  retain: readonly number[]
): Promise<ReclaimResult> {
  const all = (await session.rows(`SELECT snapshot_id FROM ducklake_snapshots('lake')`)).map((r) =>
    Number(r.snapshot_id)
  )
  if (all.length === 0) return { expired: 0, filesDeleted: 0 }

  const keep = new Set(retain)
  keep.add(all.reduce((a, b) => (a > b ? a : b)))
  const doomed = all.filter((id) => !keep.has(id))

  if (doomed.length > 0) {
    await session.run(`CALL ducklake_expire_snapshots('lake', versions => [${doomed.join(',')}])`)
  }
  // `cleanup_all` skips the grace period meant to let in-flight scans finish.
  // Cutting those readers off is the point of a purge — the same call layer 1
  // makes when it deletes the object holding purged content.
  const deleted = await session.rows(`CALL ducklake_cleanup_old_files('lake', cleanup_all => true)`)
  return { expired: doomed.length, filesDeleted: deleted.length }
}

/**
 * Delete Parquet under the data path that the catalog has never tracked.
 *
 * DuckLake writes a file before committing it, so a process that dies in
 * between leaves one nothing references — not the catalog, and so not
 * `cleanup_old_files` either, which only deletes what expiry scheduled. Left
 * alone they accumulate for the life of the deployment.
 *
 * `olderThan` is what keeps a write in flight from looking like one of them:
 * a file younger than it is never a candidate, however untracked it currently
 * is. It has to exceed the longest gap between writing a Parquet and
 * committing it — which is why the window is generous rather than tuned.
 *
 * @param dryRun - list what would go without deleting it.
 */
export async function deleteOrphanedFiles(
  session: LakeSession,
  olderThan: Date,
  dryRun = false
): Promise<string[]> {
  const rows = await session.rows(
    `CALL ducklake_delete_orphaned_files('lake', dry_run => ${dryRun},` +
      ` older_than => TIMESTAMPTZ '${olderThan.toISOString()}')`
  )
  return rows.map((r) => String(r.path))
}
