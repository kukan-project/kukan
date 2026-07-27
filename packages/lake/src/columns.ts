/** Column list of a DuckDB relation, shared by ingest's schema check and diff. */
import type { LakeSession } from './connection'

export interface LakeColumn {
  name: string
  type: string
}

/**
 * @param relation - a FROM-clause expression: `read_parquet('…')`, `lake.t`, or
 *   `lake.t AT (VERSION => n)`.
 */
export async function describeColumns(
  session: LakeSession,
  relation: string
): Promise<LakeColumn[]> {
  const rows = await session.rows(`DESCRIBE SELECT * FROM ${relation}`)
  return rows.map((r) => ({ name: String(r.column_name), type: String(r.column_type) }))
}

/**
 * Positional comparison — `EXCEPT ALL` matches columns by position, not name, so
 * two versions are row-comparable only when their columns line up exactly. A
 * pure reorder counts as a schema change: comparing it positionally would report
 * every row as both added and removed, or fail outright on incompatible types.
 */
export function sameColumns(a: LakeColumn[], b: LakeColumn[]): boolean {
  return a.length === b.length && a.every((c, i) => c.name === b[i].name && c.type === b[i].type)
}
