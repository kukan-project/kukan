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
import { and, eq, isNotNull, notInArray, sql } from 'drizzle-orm'
import type { Database, Transaction } from '@kukan/db'
import { job, resource, resourceVersion } from '@kukan/db'
import type { LakeConfig, LakeSession, ReclaimResult } from '@kukan/lake'
import {
  dropResourceTablesIn,
  lakeTableResourceIds,
  reclaimUnreferencedSnapshots,
  withLakeSession,
} from '@kukan/lake'
import type { QueueAdapter } from '@kukan/queue-adapter'
import { DROP_LAKE_TABLES_JOB_TYPE } from '@kukan/shared'
import { STRANDED_LAKE_TABLES_LOCK, tryLockInTransaction } from './advisory-lock'
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
 * Queue the lake half of a purge in `tx`, the transaction that deletes the
 * resources' rows: the job exists exactly when the deletion does, and runs
 * after it, which the reclaim needs (see {@link reclaimLakeStorage}).
 */
export async function queueLakeTablesDrop(
  queue: QueueAdapter,
  tx: Transaction,
  resourceIds: string[]
): Promise<void> {
  if (resourceIds.length === 0) return
  await queue.enqueue(DROP_LAKE_TABLES_JOB_TYPE, { resourceIds }, { tx })
}

/**
 * Drop the tables of resources whose rows are gone, then free what they held —
 * the job {@link queueLakeTablesDrop} queues. Both halves are idempotent, so a
 * retry after either one only repeats it.
 */
export async function dropPurgedLakeTables(
  db: Database,
  lake: LakeConfig | undefined,
  resourceIds: string[]
): Promise<ReclaimResult> {
  if (!lake) return { expired: 0, filesDeleted: 0 }
  return withLakeSession(lake, async (session) => {
    await dropResourceTablesIn(session, resourceIds)
    return reclaimInSession(db, session)
  })
}

/**
 * Queue the drop again for tables whose resource is gone with no job behind
 * them. A drop job lost — deleted from the admin screen, or pruned dead — is
 * how a purged dataset's tables outlive it: its rows went with the purge, so
 * nothing else remembers them. A dead job still there is left alone for that
 * screen.
 *
 * A table is written only while its resource's row exists, and a purged id
 * never comes back, so a table without a row is one no writer will touch
 * again.
 */
export async function queueStrandedLakeTables(
  db: Database,
  queue: QueueAdapter,
  lake: LakeConfig | undefined
): Promise<{ queued: number }> {
  if (!lake) return { queued: 0 }
  // Every task runs this in the same minute; one pass covers them all, and the
  // rest find the lock taken and skip
  return queue.transaction(db, async (tx) => {
    if (!(await tryLockInTransaction(tx, STRANDED_LAKE_TABLES_LOCK, ''))) return { queued: 0 }
    const tables = await withLakeSession(lake, lakeTableResourceIds, { rerunIfLost: true })
    const live = new Set(
      tables.length === 0
        ? []
        : (
            await tx
              .select({ id: resource.id })
              .from(resource)
              .where(sql`${resource.id} = ANY(${pgArray(tables)}::uuid[])`)
          ).map((r) => r.id)
    )
    const gone = tables.filter((id) => !live.has(id))
    if (gone.length === 0) return { queued: 0 }

    const queued = await tx
      .select({ payload: job.payload })
      .from(job)
      .where(
        and(
          eq(job.type, DROP_LAKE_TABLES_JOB_TYPE),
          sql`${job.payload} -> 'resourceIds' ?| ${pgArray(gone)}::text[]`
        )
      )
    const behindJob = new Set(
      queued.flatMap((j) => (j.payload as { resourceIds: string[] }).resourceIds)
    )
    const stranded = gone.filter((id) => !behindJob.has(id))
    await queueLakeTablesDrop(queue, tx, stranded)
    return { queued: stranded.length }
  })
}

/**
 * One array parameter for ids read out of table names, however many there are
 * — a parameter each would run out on a large catalog. Safe as a literal: the
 * names only match as hex and hyphens.
 */
const pgArray = (ids: string[]) => `{${ids.join(',')}}`

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
