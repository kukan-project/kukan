/**
 * PostgreSQL advisory locks used to serialize work that spans more than one
 * statement, or more than one system.
 *
 * One derivation for every namespaced lock, so two call sites cannot pick keys
 * that collide by accident — they share a single 64-bit space.
 */
import { sql } from 'drizzle-orm'
import type { Database, Transaction } from '@kukan/db'

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
 * Hold `<namespace>:<id>` for the rest of the transaction.
 *
 * Every query inside must run on `tx`: the lock *is* a pooled connection, and
 * reaching back to the pool while holding several of them deadlocks.
 */
export async function withAdvisoryLock<T>(
  db: Database,
  namespace: string,
  id: string,
  fn: (tx: Transaction) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockInTransaction(tx, namespace, id)
    return fn(tx)
  })
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

/** Take the lock inside a transaction the caller already owns. */
export async function lockInTransaction(
  tx: Pick<Database, 'execute'>,
  namespace: string,
  id: string
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${namespace}:${id}`}, 0))`)
}
