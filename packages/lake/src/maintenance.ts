/**
 * DuckLake snapshot reclamation (ADR-043 §9, layer 2).
 *
 * A purge is a legal deletion, so it is not enough to stop referencing the
 * rows — the Parquet holding them has to go. Every version owns its files
 * (Phase ii-a replaces the whole table, and data inlining is off), so expiring
 * a version's snapshot leaves its files referenced by nothing and cleanup
 * deletes them whole. No file is ever rewritten.
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
  retain: Iterable<number>
): Promise<ReclaimResult> {
  const all = (await session.rows(`SELECT snapshot_id FROM ducklake_snapshots('lake')`)).map((r) =>
    Number(r.snapshot_id)
  )
  if (all.length === 0) return { expired: 0, filesDeleted: 0 }

  const keep = new Set(retain)
  keep.add(Math.max(...all))
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
