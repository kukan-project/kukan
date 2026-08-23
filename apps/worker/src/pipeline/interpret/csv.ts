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
import type {
  ColumnStats,
  NoTableReason,
  ResourceColumn,
  ResourceColumnType,
  ResourceSchema,
} from '@kukan/shared'
import {
  CSV_FOOTER_SCAN_ROWS,
  DROPPED_LINE_SAMPLE,
  INTERPRET_MEMORY_LIMIT_MB,
  INTERPRET_THREADS,
  PARQUET_ROW_GROUP_SIZE,
  STATS_COLUMNS_PER_QUERY,
} from '@/config'
import { looksLikeSignOff, type CsvDialect } from './csv-sign-off'

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
 * Refused lines read at a time when deciding whether they are all sign-offs.
 *
 * Every one of them is judged, and a file can be refused from end to end, so the
 * read is batched rather than bounded — this caps what is held at once, not what
 * is looked at.
 */
const REJECT_BATCH = 500

/**
 * `sample_size = -1` reads every row before deciding a type. The default of
 * 20480 breaks two ways: a value below it that does not fit fails the read with
 * a conversion error, and one that *does* fit — a `0123` code among integers —
 * is silently rewritten to `123`. The second is the reason this is not
 * negotiable. It cost +375ms on 43.8MB in the spike (ADR-046).
 *
 * `ignore_errors` is about a different failure, and a worse one. The sniffer
 * scores a delimiter by how consistently the rows split under it, so a single
 * row of a different width — the version line Japanese open data signs a file
 * off with, or one stray comma anywhere in the file — makes every candidate
 * look wrong and it reads the whole thing as **one VARCHAR column named after
 * the header line** (#449). Every column of the resource is gone, the ingest
 * reports success, and nothing records that anything happened. Allowed to drop
 * the row that does not fit, it reads the rest as the table it is.
 *
 * `store_rejects` is what makes that legitimate. On its own `ignore_errors`
 * discards rows and says nothing — measured, on a middle row one field too wide
 * and on one a field too narrow. With it, each refusal is a row in
 * `reject_errors` carrying the line number and the text, which is what
 * {@link rejectedLines} counts and the schema carries out to a reader.
 *
 * Neither changes a file that reads correctly today: measured over well-formed,
 * quoted-with-commas, leading-zero and mixed-type inputs, the columns, the types
 * and the row counts are identical and nothing is rejected.
 */
function readOptions(path: string, skipRows: number, asText: string[]): string {
  const parts = [
    sqlLiteral(path),
    'sample_size = -1',
    'ignore_errors = true',
    'store_rejects = true',
  ]
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

/** What one pass over a CSV produced, or why it produced nothing. */
export interface InterpretedCsv {
  schema: ResourceSchema
  /**
   * Set where the file was refused rather than read, and then **no Parquet was
   * written** — the caller has nothing to hand on. The schema still carries
   * which lines were refused, because that is what there is to act on.
   */
  reason?: NoTableReason
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
): Promise<InterpretedCsv> {
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

    // Before the trim, because this is about what the *reader* did: which lines
    // it refused, and whether all of them read as sign-offs.
    const dropped = await rejectedLines(conn, columns)
    if (dropped.notAllNotes) {
      // Refused. Something the reader would not take was not a sign-off either,
      // and a table quietly short of a row publishes counts that are wrong with
      // nothing to show for it.
      return {
        schema: {
          columns: [],
          rowCount: 0,
          droppedRows: dropped.count,
          droppedLines: dropped.lines,
        },
        reason: 'ragged-rows',
      }
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

    return {
      schema: {
        columns: await describeColumns(conn, columns, rowCount),
        rowCount,
        ...(dropped.count > 0 && { droppedRows: dropped.count, droppedLines: dropped.lines }),
      },
    }
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
 * Rows `read_csv` refused, counted by line.
 *
 * One row that does not fit files an error per column it could not fill, so the
 * distinct lines are the rows. Read after the last load: both loads are of the
 * same file, so a re-read for {@link OVERSIZE_INTEGER} refuses the same lines
 * and the count does not double.
 *
 * Left unbounded on purpose, and it is not free: `reject_errors` takes a row per
 * column the line could not fill, so the cost is lines times width. 200,000
 * refused lines measured 1.3s over three columns, 10s over ten and 36s over
 * thirty. Capping it does not help — `rejects_limit` bounds the table but not
 * the reader's per-error path (12.6s to 10.8s measured) — and it would turn the
 * count into a floor for exactly the files where the size of the problem is
 * what a publisher needs to be told.
 */
async function rejectedLines(
  conn: DuckDBConnection,
  columns: Column[]
): Promise<{ count: number; lines: number[]; notAllNotes: boolean }> {
  const [{ n }] = (
    await conn.runAndReadAll('SELECT count(DISTINCT line) AS n FROM reject_errors')
  ).getRowObjectsJson() as { n: number }[]
  if (Number(n) === 0) return { count: 0, lines: [], notAllNotes: false }

  const rows = (
    await conn.runAndReadAll(
      `SELECT DISTINCT line FROM reject_errors ORDER BY line LIMIT ${DROPPED_LINE_SAMPLE}`
    )
  ).getRowObjectsJson() as { line: number }[]
  return {
    count: Number(n),
    lines: rows.map((row) => Number(row.line)),
    notAllNotes: await refusedMoreThanNotes(conn, columns, Number(n)),
  }
}

/**
 * Whether the reader refused anything that does not read as a sign-off.
 *
 * The rule itself is `csv-sign-off.ts`; this fetches what it needs. The lines
 * come back as text because counting their values is a parser's job — the file
 * this exists for quotes every cell — and in batches because a file can be
 * refused from end to end. **Every refused line is judged**, not a sample of
 * them: how many the schema carries out to a reader is a separate question, and
 * a file with one more note than that must not become a different file.
 *
 * The walk stops at the first line that is not a sign-off, which is every case
 * but the one where they all are.
 */
async function refusedMoreThanNotes(
  conn: DuckDBConnection,
  columns: Column[],
  count: number
): Promise<boolean> {
  const [dialect] = (
    await conn.runAndReadAll('SELECT delimiter, quote, escape FROM reject_scans LIMIT 1')
  ).getRowObjectsJson() as unknown as CsvDialect[]

  for (let seen = 0; seen < count; seen += REJECT_BATCH) {
    // One row per refused line: a line files an error per column it could not
    // fill, and they all carry the same text.
    const rows = (
      await conn.runAndReadAll(`
        SELECT line, min(csv_line) AS csv_line FROM reject_errors
        GROUP BY line ORDER BY line LIMIT ${REJECT_BATCH} OFFSET ${seen}
      `)
    ).getRowObjectsJson() as { line: number; csv_line: string | null }[]
    if (rows.length === 0) break

    const notes = rows.every(
      (row) => row.csv_line !== null && looksLikeSignOff(row.csv_line, dialect, columns.length)
    )
    if (!notes) return true
  }
  return false
}

/**
 * Drop the trailing run of footer rows and return the row count that remains.
 *
 * A row is a footer when it carries at most one non-empty cell — a `合計,,` or a
 * `出典: 港区,,` that the publisher padded out to the table's width. Single-column
 * data is exempt, because every one of its rows would otherwise qualify.
 *
 * **What the first cell says is not evidence.** The rule used to drop a row
 * whose first cell began with 合計, 注, 出典 and six others, which deletes
 * 計画課, 注文番号 and any other value starting with those two characters —
 * measured, on rows with every column filled. It bought one shape that this
 * does not catch, a note of two or more values padded to the width, and it paid
 * for it by silently deleting data rows. A note left in the table is a row of
 * mostly empty cells that anyone can see; a deleted row is gone from every count
 * the catalogue publishes.
 *
 * A row that says 合計 and *has* values is a row either way: it is the
 * publisher's own total, and dropping it is a reading of the file rather than a
 * cleaning of it.
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

  const nonEmpty = columns
    .map(
      (c) =>
        `CASE WHEN nullif(trim(CAST(${sqlIdentifier(c.name)} AS VARCHAR)), '') IS NULL THEN 0 ELSE 1 END`
    )
    .join(' + ')

  const reader = await conn.runAndReadAll(`
    SELECT rn, ${columns.length > 1 ? `(${nonEmpty}) <= 1` : 'false'} AS sparse
    FROM (SELECT *, row_number() OVER () AS rn FROM t)
    WHERE rn > ${Math.max(0, total - CSV_FOOTER_SCAN_ROWS)}
    ORDER BY rn DESC
  `)
  const rows = reader.getRowObjectsJson() as { rn: number; sparse: boolean }[]

  let keep = total
  for (const row of rows) {
    if (!row.sparse) break
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
