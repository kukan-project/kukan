/**
 * KUKAN Pipeline — writing an interpreted table out (ADR-046, ADR-063)
 *
 * What every table interpretation ends with, whatever read the file: the
 * Parquet preview, the per-column facts of the schema, and the profile. All of
 * it over the table `t` the reader left in the interpretation's DuckDB, so the
 * three cannot describe different things.
 */

import type { DuckDBConnection } from '@duckdb/node-api'
import { readRowGroupRows, sqlIdentifier, sqlLiteral } from '@kukan/lake'
import { PARQUET_PREVIEW_ROW_GROUP_ROWS } from '@kukan/shared'
import type {
  ColumnStats,
  NoTableReason,
  ResourceColumn,
  ResourceColumnType,
  ResourceSchema,
} from '@kukan/shared'
import { aggregateByColumn } from './column-batches'
import { profileTable, type InterpretedProfile } from './table-profile'

export interface Column {
  name: string
  duckType: string
}

/** What one pass over a table file produced, or why it produced nothing. */
export interface InterpretedTableFile {
  schema: ResourceSchema
  /**
   * Rows in a row group of the Parquet that was written, read back from the file
   * rather than taken from {@link PARQUET_PREVIEW_ROW_GROUP_ROWS} (why:
   * `readRowGroupRows`). Absent where no Parquet was written, and on every
   * preview from before this was recorded, which is why the feed treats a
   * missing figure as unknown rather than guessing.
   *
   * What reads it: the OData feed, which decodes a whole group to serve any row
   * of it and so keeps a page inside as few as the memory affords (ADR-055).
   */
  rowGroupRows?: number
  /**
   * Set where the file was refused rather than read, and then **no Parquet was
   * written** — the caller has nothing to hand on. The schema still carries
   * which lines were refused, because that is what there is to act on.
   */
  reason?: NoTableReason
  /** The table profile (ADR-063), where one was asked for. */
  profile?: InterpretedProfile
}

/** A DuckDB type name, folded to the semantic type persisted on the schema. */
export function semanticType(duckType: string): ResourceColumnType {
  const t = duckType.toUpperCase()
  if (/^(BIGINT|INTEGER|SMALLINT|TINYINT|UBIGINT|UINTEGER|USMALLINT|UTINYINT|HUGEINT)$/.test(t)) {
    return 'integer'
  }
  if (/^(DOUBLE|FLOAT|REAL|DECIMAL)/.test(t)) return 'float'
  if (t === 'BOOLEAN') return 'boolean'
  if (t === 'DATE') return 'date'
  if (t.startsWith('TIMESTAMP')) return 'timestamp'
  return 'string'
}

/**
 * The table's columns, as the binding names them in a result rather than as
 * `DESCRIBE` reports them.
 *
 * The two differ: the binding decodes VARCHAR *values* through a decoder that
 * drops a leading U+FEFF, so a `DESCRIBE` row for a column whose name starts
 * with one comes back without it, and every identifier built from that name
 * binds to a column the table does not have. Result metadata comes through a
 * different path and keeps the name whole.
 */
export async function describe(conn: DuckDBConnection, table = 't'): Promise<Column[]> {
  const reader = await conn.runAndReadAll(`SELECT * FROM ${table} LIMIT 0`)
  const types = reader.columnTypes()
  return reader.columnNames().map((name, i) => ({ name, duckType: String(types[i]) }))
}

/**
 * Write `t` out: its Parquet preview, the per-column facts, and — for a caller
 * that publishes one — the profile.
 *
 * @param rowCount - rows in `t`, as the reader counted them after its trims.
 */
export async function writeTable(
  conn: DuckDBConnection,
  columns: Column[],
  rowCount: number,
  parquetPath: string,
  profilePath?: string
): Promise<{ described: ResourceColumn[]; rowGroupRows?: number; profile?: InterpretedProfile }> {
  // ZSTD rather than DuckDB's default: measured at 3.25 MB against Snappy's
  // 8.40 MB on the same input, and a preview page costs a third of the bytes
  // to fetch — the read is still two ranges, since compression is per page
  // inside a column chunk, so nothing has to be pulled whole.
  //
  // The browser reader was taught ZSTD first (`lib/parquet-codecs.ts`); the
  // other two readers, the DuckDB explorer (ADR-016) and the server sandbox,
  // have always handled it. Files written before this stay Snappy and are
  // never rewritten (ADR-029 §7), so the reader keeps both.
  await conn.run(
    `COPY t TO ${sqlLiteral(parquetPath)} ` +
      `(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE ${PARQUET_PREVIEW_ROW_GROUP_ROWS})`
  )

  // The number in the file, not the constant above (`readRowGroupRows`).
  const rowGroupRows = await readRowGroupRows(conn, parquetPath)

  const described = await describeColumns(conn, columns, rowCount)
  // The table profile (ADR-063), on the table the Parquet was written from:
  // the same rows, and no second read of anything. Only for a caller that
  // publishes it — a lake retry wants the table alone. Search material, so a
  // failure here costs the profile and not the preview.
  const profile = profilePath
    ? await profileTable(conn, columns, described, rowCount, profilePath).catch(
        (err: unknown): InterpretedProfile => ({
          columns: [],
          error: err instanceof Error ? err.message : String(err),
        })
      )
    : undefined
  return { described, rowGroupRows: rowGroupRows ?? undefined, ...(profile && { profile }) }
}

/**
 * Per-column facts, all of them exact and over every row: how many values are
 * missing, how many are distinct, and the bounds of the numeric ones. The
 * distinct counts are what the primary-key picker reads (ADR-046) — measured at
 * 49ms for five columns over 800,000 rows, once the table is materialized.
 */
async function describeColumns(
  conn: DuckDBConnection,
  columns: Column[],
  rowCount: number
): Promise<ResourceColumn[]> {
  const row = await aggregateByColumn(
    conn,
    columns.map((_, i) => i),
    (i) => {
      const c = columns[i]
      const col = sqlIdentifier(c.name)
      const numeric = ['integer', 'float'].includes(semanticType(c.duckType))
      return [
        `count(*) FILTER (WHERE ${col} IS NULL) AS c${i}_null`,
        `count(DISTINCT ${col}) AS c${i}_distinct`,
        ...(numeric
          ? [`min(${col})::VARCHAR AS c${i}_min`, `max(${col})::VARCHAR AS c${i}_max`]
          : []),
      ]
    }
  )

  return columns.map((c, i) => {
    const type = semanticType(c.duckType)
    const nullCount = Number(row[`c${i}_null`])
    const distinctCount = Number(row[`c${i}_distinct`])
    const min = row[`c${i}_min`]
    const max = row[`c${i}_max`]
    // Integer bounds stay decimal strings: INT64 runs past what a JS number
    // holds exactly, and the point of typing the column was to keep its digits.
    const stats: ColumnStats | undefined =
      min == null || max == null
        ? undefined
        : type === 'integer'
          ? { min: String(min), max: String(max) }
          : { min: Number(min), max: Number(max) }
    return {
      name: c.name,
      type,
      nullable: nullCount > 0,
      nullCount,
      distinctCount,
      unique: rowCount > 0 && nullCount === 0 && distinctCount === rowCount,
      ...(stats && { stats }),
    }
  })
}
