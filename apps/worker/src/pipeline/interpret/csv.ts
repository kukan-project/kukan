/**
 * KUKAN Pipeline — CSV/TSV interpretation on DuckDB (ADR-046)
 *
 * Reads a UTF-8 CSV off local disk, writes the preview Parquet, and reports the
 * column schema (ADR-032) — one interpretation, from one pass over the file, so
 * the schema and the Parquet cannot describe different things.
 *
 * Replaces the hand-written inference of ADR-029. The spike behind ADR-046
 * found the sniffer agrees on 23 of 29 Japanese column patterns, including the
 * leading-zero codes that inference existed to protect; what it does not do on
 * its own is in {@link OVERSIZE_INTEGER} and {@link readOptions}.
 */

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { sqlIdentifier, sqlLiteral } from '@kukan/lake'
import type { ColumnStats, ResourceColumn, ResourceColumnType, ResourceSchema } from '@kukan/shared'
import {
  CSV_FOOTER_PREFIXES,
  CSV_FOOTER_SCAN_ROWS,
  INTERPRET_MEMORY_LIMIT_MB,
  INTERPRET_THREADS,
  PARQUET_ROW_GROUP_SIZE,
  STATS_COLUMNS_PER_QUERY,
} from '@/config'

/** A DuckDB type name, folded to the semantic type persisted on the schema. */
function semanticType(duckType: string): ResourceColumnType {
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
 * A DOUBLE column whose values are whole numbers this large came from integer
 * text of more than 15 digits, which is where a double stops holding every
 * digit — `99999999999999999999` reads back as `1e+20`. Those columns are
 * re-read as text, the same call ADR-029 made for the same reason.
 *
 * Genuine floating-point data can trip this, and is then typed as text rather
 * than losing digits; that is the direction to err in. Correcting it through
 * `auto_type_candidates` is not an option — adding DECIMAL there silently
 * rounds `1.5` to `2` (ADR-046).
 */
const OVERSIZE_INTEGER = '1e15'

/**
 * `sample_size = -1` reads every row before deciding a type. The default of
 * 20480 breaks two ways: a value below it that does not fit fails the read with
 * a conversion error, and one that *does* fit — a `0123` code among integers —
 * is silently rewritten to `123`. The second is the reason this is not
 * negotiable. It cost +375ms on 43.8MB in the spike (ADR-046).
 */
function readOptions(path: string, skipRows: number, asText: string[]): string {
  const parts = [sqlLiteral(path), 'sample_size = -1']
  if (skipRows > 0) parts.push(`skip = ${skipRows}`)
  if (asText.length > 0) {
    parts.push(`types = {${asText.map((c) => `${sqlLiteral(c)}: 'VARCHAR'`).join(', ')}}`)
  }
  return parts.join(', ')
}

interface Column {
  name: string
  duckType: string
}

/**
 * Interpret `csvPath` (UTF-8) and write its Parquet preview to `parquetPath`.
 *
 * @param skipRows - leading rows to drop before the header, from the caller's
 *   title-row scan. DuckDB finds the header but has no notion of the title
 *   lines Japanese spreadsheets put above it.
 */
export async function interpretCsv(
  csvPath: string,
  parquetPath: string,
  skipRows: number
): Promise<ResourceSchema> {
  const instance = await DuckDBInstance.create(':memory:', {
    memory_limit: `${INTERPRET_MEMORY_LIMIT_MB}MB`,
    threads: String(INTERPRET_THREADS),
  })
  const conn = await instance.connect()
  try {
    // Materialized rather than streamed straight into the COPY: the schema needs
    // exact distinct counts over every row, and reading the file twice to get
    // them costs more than holding it once. DuckDB spills to disk under
    // `memory_limit`, so a file larger than the cap still completes.
    //
    // Described from the table, never from the `read_csv` call: with
    // `sample_size = -1` a DESCRIBE over the reader re-sniffs the whole file,
    // which on 27MB cost as much again as the load itself.
    await conn.run(
      `CREATE TABLE t AS SELECT * FROM read_csv(${readOptions(csvPath, skipRows, [])})`
    )
    let columns = await describe(conn)

    const oversize = await oversizeIntegerColumns(conn, columns)
    if (oversize.length > 0) {
      const opts = readOptions(csvPath, skipRows, oversize)
      await conn.run(`CREATE OR REPLACE TABLE t AS SELECT * FROM read_csv(${opts})`)
      columns = await describe(conn)
    }

    const rowCount = await trimFooter(conn, columns)
    // ZSTD rather than DuckDB's default: measured at 3.25 MB against Snappy's
    // 8.40 MB on the same input, and a preview page costs a third of the bytes
    // to fetch — the read is still two ranges, since compression is per page
    // inside a column chunk, so nothing has to be pulled whole (#242).
    //
    // The browser reader was taught ZSTD first (`hooks/parquet-codecs.ts`); the
    // other two readers, the DuckDB explorer (ADR-016) and the server sandbox,
    // have always handled it. Files written before this stay Snappy and are
    // never rewritten (ADR-029 §7), so the reader keeps both.
    await conn.run(
      `COPY t TO ${sqlLiteral(parquetPath)} ` +
        `(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE ${PARQUET_ROW_GROUP_SIZE})`
    )

    return { columns: await describeColumns(conn, columns, rowCount), rowCount }
  } finally {
    conn.disconnectSync()
    instance.closeSync()
  }
}

async function describe(conn: DuckDBConnection): Promise<Column[]> {
  const reader = await conn.runAndReadAll('DESCRIBE t')
  return (reader.getRowObjectsJson() as { column_name: string; column_type: string }[]).map(
    (r) => ({
      name: r.column_name,
      duckType: r.column_type,
    })
  )
}

/** DOUBLE columns holding whole numbers too large for a double to keep exactly. */
async function oversizeIntegerColumns(
  conn: DuckDBConnection,
  columns: Column[]
): Promise<string[]> {
  const doubles = columns.filter((c) => semanticType(c.duckType) === 'float')
  if (doubles.length === 0) return []
  // Aliased by position, never by column name: a CSV header is arbitrary text —
  // quotes, newlines, empty — and building identifiers out of it is how this
  // produces unparseable SQL.
  const reader = await conn.runAndReadAll(
    `SELECT ${doubles
      .map(
        (c, i) =>
          `count(*) FILTER (WHERE abs(${sqlIdentifier(c.name)}) >= ${OVERSIZE_INTEGER}` +
          ` AND ${sqlIdentifier(c.name)} = floor(${sqlIdentifier(c.name)})) AS c${i}`
      )
      .join(', ')} FROM t`
  )
  const [row] = reader.getRowObjectsJson() as Record<string, unknown>[]
  return doubles.filter((_, i) => Number(row[`c${i}`]) > 0).map((c) => c.name)
}

/**
 * Drop the trailing run of footer rows and return the row count that remains.
 *
 * The rule is the one the hand-written extractor used: a row is a footer when
 * its first cell starts with a known prefix, or — only when the data has more
 * than one column — when it carries at most one non-empty cell. Single-column
 * data is exempt because every one of its rows would otherwise qualify.
 *
 * Only the last {@link CSV_FOOTER_SCAN_ROWS} rows are examined, since the run
 * has to reach the bottom of the file to be a footer at all.
 */
async function trimFooter(conn: DuckDBConnection, columns: Column[]): Promise<number> {
  const [{ n }] = (await conn.runAndReadAll('SELECT count(*) AS n FROM t')).getRowObjectsJson() as {
    n: number
  }[]
  const total = Number(n)
  if (total === 0) return 0

  const first = sqlIdentifier(columns[0].name)
  const nonEmpty = columns
    .map(
      (c) =>
        `CASE WHEN nullif(trim(CAST(${sqlIdentifier(c.name)} AS VARCHAR)), '') IS NULL THEN 0 ELSE 1 END`
    )
    .join(' + ')
  const prefixTest = CSV_FOOTER_PREFIXES.map(
    (p) => `starts_with(lower(trim(CAST(${first} AS VARCHAR))), ${sqlLiteral(p)})`
  ).join(' OR ')

  const reader = await conn.runAndReadAll(`
    SELECT rn, coalesce(${prefixTest}, false) AS prefixed,
      ${columns.length > 1 ? `(${nonEmpty}) <= 1` : 'false'} AS sparse
    FROM (SELECT *, row_number() OVER () AS rn FROM t)
    WHERE rn > ${Math.max(0, total - CSV_FOOTER_SCAN_ROWS)}
    ORDER BY rn DESC
  `)
  const rows = reader.getRowObjectsJson() as { rn: number; prefixed: boolean; sparse: boolean }[]

  let keep = total
  for (const row of rows) {
    if (!row.prefixed && !row.sparse) break
    keep = Number(row.rn) - 1
  }
  if (keep === total) return total

  // Rewritten rather than deleted by row number: `row_number()` has no stable
  // meaning across statements, so the cut has to happen inside the one that
  // computed it.
  await conn.run(`CREATE OR REPLACE TABLE t AS
    SELECT * EXCLUDE (rn) FROM (SELECT *, row_number() OVER () AS rn FROM t) WHERE rn <= ${keep}`)
  return keep
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
  const row: Record<string, unknown> = {}
  for (let start = 0; start < columns.length; start += STATS_COLUMNS_PER_QUERY) {
    // Aliased by the column's global position, so the batches merge into one
    // row (batched at all: see STATS_COLUMNS_PER_QUERY).
    const selects = columns.slice(start, start + STATS_COLUMNS_PER_QUERY).flatMap((c, j) => {
      const i = start + j
      const col = sqlIdentifier(c.name)
      const numeric = ['integer', 'float'].includes(semanticType(c.duckType))
      return [
        `count(*) FILTER (WHERE ${col} IS NULL) AS c${i}_null`,
        `count(DISTINCT ${col}) AS c${i}_distinct`,
        ...(numeric
          ? [`min(${col})::VARCHAR AS c${i}_min`, `max(${col})::VARCHAR AS c${i}_max`]
          : []),
      ]
    })
    const [batch] = (
      await conn.runAndReadAll(`SELECT ${selects.join(', ')} FROM t`)
    ).getRowObjectsJson() as Record<string, unknown>[]
    Object.assign(row, batch)
  }

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
