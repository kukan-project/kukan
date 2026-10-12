/**
 * DuckLake tables (ADR-043 layer 2) — naming and whole-table operations.
 *
 * Names are derived mechanically from the resource UUID so renames never touch
 * the physical layer; the human-readable name is never carried into DuckLake.
 */
import type { LakeSession } from './connection'
import { assertSafeIdentifier, sqlLiteral } from './sql'

/** DuckLake table name for a resource: `res_<uuid without hyphens>`. */
export function lakeTableName(resourceId: string): string {
  return `res_${resourceId.replace(/-/g, '')}`
}

/** Reference to a table in the session's catalog, with the identifier guard applied. */
export function lakeTableRef(session: LakeSession, table: string): string {
  return `${assertSafeIdentifier(session.catalog)}.${assertSafeIdentifier(table)}`
}

/** `FROM` clause reading a table as of one snapshot. */
export function lakeTableAt(ref: string, snapshot: number): string {
  return `${ref} AT (VERSION => ${Math.trunc(snapshot)})`
}

export async function lakeTableExists(session: LakeSession, table: string): Promise<boolean> {
  const rows = await session.rows(
    `SELECT 1 FROM duckdb_tables() WHERE database_name = ${sqlLiteral(session.catalog)} ` +
      `AND table_name = ${sqlLiteral(table)}`
  )
  return rows.length > 0
}

/**
 * Snapshot id for the write that just committed.
 *
 * The catalog's maximum, which only identifies one caller's commit while it is
 * the catalog's only writer — a resource's own catalog, under its claim.
 */
export async function currentSnapshotId(session: LakeSession): Promise<number> {
  const [row] = await session.rows(
    `SELECT max(snapshot_id) AS id FROM ducklake_snapshots(${sqlLiteral(session.catalog)})`
  )
  return Number(row.id)
}
