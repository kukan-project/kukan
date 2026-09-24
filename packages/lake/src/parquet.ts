/**
 * What a Parquet file says about itself, for the readers that have to page by it.
 */

import { sqlLiteral } from './sql'

/** The narrow shape this needs of a DuckDB connection, like the rest of the
 *  raw-connection helpers here. */
interface Queryable {
  runAndReadAll(sql: string): Promise<{ getRowObjectsJson(): unknown[] }>
}

/**
 * Rows in a row group of the Parquet at `location`, from its footer.
 *
 * **Asked of the file rather than assumed, and asked in one place.** A Parquet
 * read decodes a whole row group to hand out one row of it, so this is the unit
 * a reader has to page by (ADR-055) — and it cannot be taken from the size the
 * writer was asked for: DuckDB rounds that up to a multiple of its 2,048-row
 * vector, and the hyparquet writer that made KUKAN's earlier previews did not.
 * The step that writes a preview and the feed that serves one both come through
 * here, so the figure they page by cannot drift apart.
 *
 * **One size, or none.** A reader cuts pages at multiples of this figure, so it
 * is only a figure if every group but the last holds the same number of rows.
 * The parallel writer does not promise that — a group can come out larger than
 * the size asked for — and the largest group of such a file would put the cuts
 * where no boundary is. Such a file answers null, as unknown, and is paged by
 * bytes alone.
 *
 * Null too where the file holds no row groups — an interpretation that found no
 * rows — or where the footer answers with something that is not a count.
 */
export async function readRowGroupRows(conn: Queryable, location: string): Promise<number | null> {
  const rows = (
    await conn.runAndReadAll(
      `WITH g AS (SELECT row_group_id AS id, any_value(row_group_num_rows) AS n ` +
        `FROM parquet_metadata(${sqlLiteral(location)}) GROUP BY row_group_id) ` +
        `SELECT count(*) AS groups, max(n) AS widest, ` +
        `count(DISTINCT n) FILTER (WHERE id < (SELECT max(id) FROM g)) AS shapes, ` +
        `max(n) FILTER (WHERE id < (SELECT max(id) FROM g)) AS size FROM g`
    )
  )
    // BIGINTs come back as strings, and as null where there are no groups
    .getRowObjectsJson() as {
    groups: string
    widest: string | null
    shapes: string
    size: string | null
  }[]
  const row = rows[0]
  if (!row) return null
  const groups = Number(row.groups)
  // One group is its own size; more must agree on it, the last excepted.
  const raw = groups === 1 ? row.widest : Number(row.shapes) === 1 ? row.size : null
  const value = raw == null ? null : Number(raw)
  return value !== null && Number.isSafeInteger(value) && value > 0 ? value : null
}
