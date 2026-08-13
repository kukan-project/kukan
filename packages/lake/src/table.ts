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

/**
 * Replace a table's contents with an earlier snapshot's, and return the
 * snapshot that lands them.
 *
 * The contents are the old snapshot's, the snapshot is a new one — nothing
 * rewinds a catalog. Recording the returned id against the version whose rows
 * these are is what tells a later reader the table is already standing on it,
 * which neither the old snapshot id nor the version rows can say by themselves.
 */
export async function rollbackLakeTable(
  session: LakeSession,
  table: string,
  snapshot: number
): Promise<number> {
  const ref = lakeTableRef(table)
  await session.run(
    `CREATE OR REPLACE TABLE ${ref} AS SELECT * FROM ${ref} AT (VERSION => ${Math.trunc(snapshot)})`
  )
  return currentSnapshotId(session)
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
