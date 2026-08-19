/**
 * Freeing the DuckLake storage a deletion left behind (ADR-043 §5, layer 2).
 *
 * Dropping a table, rolling one back, or deleting the rows that referenced its
 * snapshots only stops the data being reachable. The Parquet stays until the
 * snapshots are expired and cleanup deletes what that frees — which is the
 * difference between "unreachable" and the physical erasure a purge claims.
 *
 * Separate from the callers because every path that unreferences a snapshot
 * needs it: purging a version, a package, an organization, or a draft. Leaving
 * it inside one of them made the guarantee a property of that call site rather
 * than of deletion.
 */
import { and, isNotNull, notInArray } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resourceVersion } from '@kukan/db'
import type { LakeConfig, LakeSession, ReclaimResult } from '@kukan/lake'
import { reclaimUnreferencedSnapshots, withLakeSession } from '@kukan/lake'
import { withLakeIngestLock } from './lake-ingest'

/**
 * Expire every snapshot no surviving version references, and delete the files
 * that frees.
 *
 * **Call after the rows are gone.** The retained set is read from
 * `resource_version`, so a snapshot whose row still exists counts as live —
 * running this before the deletion commits would free nothing.
 *
 * Idempotent: with nothing left unreferenced it expires nothing, and cleanup
 * finds nothing to delete. Safe to call from a path that may already have run.
 */
export async function reclaimLakeStorage(
  db: Database,
  lake: LakeConfig | undefined
): Promise<ReclaimResult> {
  if (!lake) return { expired: 0, filesDeleted: 0 }
  return withLakeSession(lake, (session) => reclaimInSession(db, session))
}

/**
 * The same work on a session the caller already has, for a purge that opened
 * one to roll a table back first.
 */
export async function reclaimInSession(db: Database, session: LakeSession): Promise<ReclaimResult> {
  return withLakeIngestLock(db, async (tx) => {
    // Snapshot ids are one catalog-wide sequence, so the retained set spans
    // every resource. On `tx`, not the pool: the lock is itself a pooled
    // connection, and reaching back for another while holding several
    // deadlocks. Under the lock, which is what stops this from expiring a
    // snapshot an ingest has committed but not yet recorded on its version row.
    // What a surviving version still names, which is wider than the versions
    // layer 2 can be stood on. A snapshot outlives being the current contents:
    // a diff resolves two versions to their snapshots and reads both, so
    // expiring the one a revert moved off would break comparing against it.
    //
    // Written as an exclusion rather than `active`, so a row still saying
    // `superseded` — the scheme before a revert published forward (ADR-044 §4)
    // — keeps its snapshot. Those versions are readable and diffable like any
    // other; they are only not where layer 2 stands.
    //
    // `purging` is excluded with `purged`, and that exclusion is load-bearing:
    // a version purge calls this from inside its own run, before it can set the
    // row to `purged` (that write also nulls the snapshot). Retaining a row
    // mid-purge would leave the purged version's files on disk with nothing but
    // a package or organization purge able to reach them.
    const retained = await tx
      .select({ snapshot: resourceVersion.ducklakeSnapshotId })
      .from(resourceVersion)
      .where(
        and(
          notInArray(resourceVersion.state, ['purged', 'purging']),
          isNotNull(resourceVersion.ducklakeSnapshotId)
        )
      )
    return reclaimUnreferencedSnapshots(
      session,
      retained.map((r) => r.snapshot!)
    )
  })
}
