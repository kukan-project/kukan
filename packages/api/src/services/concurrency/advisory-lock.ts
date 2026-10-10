/**
 * PostgreSQL advisory locks used to serialize work that spans more than one
 * statement, or more than one system.
 *
 * One derivation for every namespaced lock, so two call sites cannot pick keys
 * that collide by accident — they share a single 64-bit space.
 */
import { sql } from 'drizzle-orm'
import type { Database, Transaction } from '@kukan/db'
import { inTurn } from '@kukan/shared'

/** Serialize per-package resource position writes (max+1 vs. renumbering). */
export const RESOURCE_POSITION_LOCK = 'resource_position'

/**
 * Serialize DuckLake ingest across the whole catalog (ADR-043 layer 2).
 *
 * Not per resource: snapshot ids increase across the catalog and a commit's
 * snapshot is identified by reading back the maximum, so two concurrent ingests
 * would each be able to observe the other's. Ingest only runs when a resource's
 * content changes, so serializing costs little next to the certainty it buys.
 */
export const LAKE_INGEST_LOCK = 'lake_ingest'

/**
 * Serialize the search-document sync (ADR-053 §9.3): resources' documents and
 * datasets'.
 *
 * Two writers of the same document — the sync job, an edit, the rebuild — can
 * land out of order: the one that read the row first can write last, putting
 * the older document back after the newer one cleared the mark. One at a time,
 * each batch's write lands before the next batch reads. The key is the one it
 * had when it held resources alone, so processes on either side of an upgrade
 * still take turns.
 */
export const SEARCH_DOC_SYNC_LOCK = 'resource_doc_sync'

/**
 * One embed job at a time (ADR-054). The job holds no row while the provider
 * works, so two of them read the same oldest marks and pay for the same texts
 * twice; the compare-and-set keeps the result right, not the bill.
 */
export const RESOURCE_EMBED_LOCK = 'resource_embed'

/**
 * One pass at a time over the lake tables left without a drop job. Every
 * worker task runs the hourly sweep in the same minute; without it each would
 * find the same tables and queue its own drop for them.
 */
export const STRANDED_LAKE_TABLES_LOCK = 'stranded_lake_tables'

/**
 * Hold `<namespace>:<id>` for the rest of the transaction.
 *
 * Every query inside must run on `tx`: the lock *is* a pooled connection, and
 * reaching back to the pool while holding several of them deadlocks.
 *
 * Callers in one process take turns before they take a connection (ADR-058
 * §7). Waiting in the database, each would hold one: several jobs reaching the
 * same lock at once would fill the pool with waiters and time out whatever
 * else needed a connection meanwhile.
 */
export async function withAdvisoryLock<T>(
  db: Database,
  namespace: string,
  id: string,
  fn: (tx: Transaction) => Promise<T>
): Promise<T> {
  return inTurn(`${namespace}:${id}`, () =>
    db.transaction(async (tx) => {
      await lockInTransaction(tx, namespace, id)
      return fn(tx)
    })
  )
}

/**
 * Hold a namespace with no id — one lock for the whole system, not one per row.
 */
export async function withGlobalAdvisoryLock<T>(
  db: Database,
  namespace: string,
  fn: (tx: Transaction) => Promise<T>
): Promise<T> {
  return withAdvisoryLock(db, namespace, '', fn)
}

/** The 64-bit key a namespaced lock is held under — one derivation for both ways of taking it */
const lockKey = (namespace: string, id: string) => sql`hashtextextended(${`${namespace}:${id}`}, 0)`

/** Take the lock inside a transaction the caller already owns. */
export async function lockInTransaction(
  tx: Pick<Database, 'execute'>,
  namespace: string,
  id: string
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey(namespace, id)})`)
}

/** Take the lock inside a transaction if nobody holds it; false if somebody does. */
export async function tryLockInTransaction(
  tx: Pick<Database, 'execute'>,
  namespace: string,
  id: string
): Promise<boolean> {
  const result = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(${lockKey(namespace, id)}) AS locked`
  )
  return (result.rows[0] as { locked: boolean }).locked
}
