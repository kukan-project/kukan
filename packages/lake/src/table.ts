/**
 * DuckLake tables (ADR-043 layer 2) — naming and whole-table operations.
 *
 * Names are derived mechanically from the resource UUID so renames never touch
 * the physical layer; the human-readable name is never carried into DuckLake.
 */
import type { LakeConfig } from './config'
import type { LakeSession } from './connection'
import { withLakeSession } from './connection'
import { assertSafeIdentifier, sqlLiteral } from './sql'

/** DuckLake table name for a resource: `res_<uuid without hyphens>`. */
export function lakeTableName(resourceId: string): string {
  return `res_${resourceId.replace(/-/g, '')}`
}

/** Catalog-qualified reference, with the identifier guard applied. */
export function lakeTableRef(table: string): string {
  return `lake.${assertSafeIdentifier(table)}`
}

/** `FROM` clause reading a table as of one snapshot. */
export function lakeTableAt(ref: string, snapshot: number): string {
  return `${ref} AT (VERSION => ${Math.trunc(snapshot)})`
}

export async function lakeTableExists(session: LakeSession, table: string): Promise<boolean> {
  const rows = await session.rows(
    `SELECT 1 FROM duckdb_tables() WHERE database_name = 'lake' AND table_name = ${sqlLiteral(table)}`
  )
  return rows.length > 0
}

export async function dropLakeTable(session: LakeSession, table: string): Promise<void> {
  await session.run(`DROP TABLE IF EXISTS ${lakeTableRef(table)}`)
}

/**
 * Snapshot id for the write that just committed.
 *
 * The catalog-wide maximum, which only identifies one caller's commit while
 * writes are serialized — every caller must hold the ingest lock.
 */
export async function currentSnapshotId(session: LakeSession): Promise<number> {
  const [row] = await session.rows(`SELECT max(snapshot_id) AS id FROM ducklake_snapshots('lake')`)
  return Number(row.id)
}

/** Every snapshot the catalog holds, across all tables — the ids are one sequence. */
export async function snapshotIds(session: LakeSession): Promise<number[]> {
  const rows = await session.rows(`SELECT snapshot_id FROM ducklake_snapshots('lake')`)
  return rows.map((r) => Number(r.snapshot_id))
}

/**
 * Which of these snapshots the catalog can still read a table as.
 *
 * Asked before standing a table on a recorded id, which a version row can carry
 * long after `ducklake_expire_snapshots` took the snapshot away — a restore of
 * an older catalog, or a reclaim that ran while the row was mid-write (spec
 * §11-5). Rolling onto one of those fails, and the caller's alternative to
 * failing is a version further down.
 *
 * The whole set in one read, rather than a query per id: `ducklake_snapshots` is
 * a table function, and a predicate on it is a filter over its full output — so
 * asking about one id costs what asking about all of them does, and the cost
 * tracks the catalog rather than the caller's list (measured: ~5ms at 400
 * snapshots, ~10ms at 1600, either way).
 *
 * Catalog resolution only. A snapshot whose Parquet has been deleted underneath
 * it resolves here and fails on the read; that is reconciliation's to repair,
 * not something to pick a restore target by.
 */
export async function resolvableSnapshots(
  session: LakeSession,
  snapshots: readonly number[]
): Promise<Set<number>> {
  if (snapshots.length === 0) return new Set()
  const held = new Set(await snapshotIds(session))
  return new Set(snapshots.filter((id) => held.has(id)))
}

/**
 * Drop several resources' tables in one session.
 *
 * Callers pass only resources known to have been ingested — opening a session
 * costs extension loads and a catalog ATTACH, far more than the drops. The ids
 * are then intersected with the catalog, because `DROP TABLE IF EXISTS` on a
 * name that was never there is still a catalog transaction each.
 */
export async function dropResourceTables(config: LakeConfig, resourceIds: string[]): Promise<void> {
  if (resourceIds.length === 0) return
  await withLakeSession(config, async (session) => {
    const rows = await session.rows(
      `SELECT table_name FROM duckdb_tables() WHERE database_name = 'lake'`
    )
    const present = new Set(rows.map((r) => String(r.table_name)))
    for (const resourceId of resourceIds) {
      const table = lakeTableName(resourceId)
      if (present.has(table)) await dropLakeTable(session, table)
    }
  })
}
