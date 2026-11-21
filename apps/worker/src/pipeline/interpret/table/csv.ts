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

import type { DuckDBConnection } from '@duckdb/node-api'
import { openDuckdb, sqlIdentifier, sqlLiteral } from '@kukan/lake'
import {
  CSV_FOOTER_SCAN_ROWS,
  DROPPED_LINE_SAMPLE,
  INTERPRET_MAX_SPILL_BYTES,
  INTERPRET_MEMORY_LIMIT_MB,
  INTERPRET_THREADS,
} from '@/config'
import {
  CELL_BLANKS,
  CELL_SHAPES,
  maskOf,
  refusedLineShape,
  signOffShape,
  vouches,
  type CellShape,
  type CsvDialect,
  type LineShape,
  type TableBody,
} from './csv-sign-off'
import {
  describe,
  isOutOfMemory,
  semanticType,
  writeTable,
  type Column,
  type InterpretedTableFile,
  type ProfileRequest,
} from './write-table'
import { settleColumns, withSettledNotes, type SettledReading } from './settled-types'

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
 * the header line**. Every column of the resource is gone, the ingest
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
function readOptions(
  path: string,
  skipRows: number,
  asText: string[],
  lenient: boolean,
  storeRejects = true
): string {
  const parts = [sqlLiteral(path), 'sample_size = -1', 'ignore_errors = true']
  if (storeRejects) parts.push('store_rejects = true')
  if (lenient) parts.push('strict_mode = false')
  if (skipRows > 0) parts.push(`skip = ${skipRows}`)
  if (asText.length > 0) {
    parts.push(`types = {${asText.map((c) => `${sqlLiteral(c)}: 'VARCHAR'`).join(', ')}}`)
  }
  return parts.join(', ')
}

/**
 * Interpret `csvPath` (UTF-8) and write its Parquet preview to `parquetPath`.
 *
 * @param skipRows - leading rows to drop before the header, from the caller's
 *   title-row scan. DuckDB finds the header but has no notion of the title
 *   lines Japanese spreadsheets put above it.
 * @param profileRequest - the profile to write too (ADR-063), when the caller
 *   publishes one; a lake retry wants the table alone.
 */
export async function interpretCsv(
  csvPath: string,
  parquetPath: string,
  skipRows: number,
  profileRequest?: ProfileRequest,
  reading?: SettledReading
): Promise<InterpretedTableFile> {
  // Somewhere of its own to spill, because the load below is meant to: a
  // spill file shared with the lake instance this process also holds fails
  // both (see `useOwnTempDirectory`).
  const { conn, close } = await openDuckdb({
    memoryLimitBytes: INTERPRET_MEMORY_LIMIT_MB * 1_000_000,
    threads: INTERPRET_THREADS,
    spill: 'interpret',
    maxSpillBytes: INTERPRET_MAX_SPILL_BYTES,
  })
  try {
    // Materialized rather than streamed straight into the COPY: the schema needs
    // exact distinct counts over every row, and reading the file twice to get
    // them costs more than holding it once. DuckDB spills to disk under
    // `memory_limit`, so a file larger than the cap still completes.
    //
    // Described from the table, never from the `read_csv` call: with
    // `sample_size = -1` a DESCRIBE over the reader re-sniffs the whole file,
    // which on 27MB cost as much again as the load itself.
    const lenient = await load(conn, csvPath, skipRows)
    let columns = await describe(conn)

    // Settled columns are read as text, and cast once the table is settled
    // (§8.3); by the names the first read gave, as `types` wants them. Matched
    // without the byte order mark, which is not part of the column's name.
    const settledTypes = reading?.types ?? {}
    const settledRead = columns.filter((c) => Object.hasOwn(settledTypes, withoutMark(c.name)))
    const inferred = new Map(
      settledRead.map((c) => [withoutMark(c.name), semanticType(c.duckType)] as const)
    )

    // Columns the sniffed type does not hold, read again as text
    const asText = new Set([
      ...(await oversizeIntegerColumns(conn, columns)),
      ...(await castRefusedColumns(conn, columns)),
      ...(await signOnlyColumns(conn, csvPath, skipRows, lenient, columns)),
      ...settledRead.map((c) => c.name),
    ])
    if (asText.size > 0) {
      // The first read's refusals are what this read is for; what counts from
      // here is what this one refuses.
      await conn.run('DELETE FROM reject_errors')
      await conn.run('DELETE FROM reject_scans')
      const opts = readOptions(csvPath, skipRows, [...asText], lenient)
      await conn.run(`CREATE OR REPLACE TABLE t AS SELECT * FROM read_csv(${opts})`)
      columns = await describe(conn)
    }
    // After the last read: the `types` keys above have to be the names the
    // reader gave, marks and all.
    columns = await stripByteOrderMark(conn, columns)

    // Before the trim, because this is about what the *reader* did: which lines
    // it refused, and whether all of them read as sign-offs.
    const dropped = await rejectedLines(conn, columns)
    const settled = dropped.notes && (await settleSignOffs(conn, columns, dropped.notes))
    if (!settled || settled.brokenRow) {
      // Refused. Something the reader would not take was not a sign-off either,
      // or was a row the table has more of, and a table quietly short of a row publishes counts that are wrong with
      // nothing to show for it.
      return {
        schema: {
          columns: [],
          rowCount: 0,
          droppedRows: dropped.count,
          droppedLines: dropped.lines,
          dialect: dropped.dialect,
          ...(lenient && { lenient }),
        },
        reason: 'ragged-rows',
      }
    }

    if (settled.footer > 0) await cutFooter(conn, settled.total, settled.footer)
    const rowCount = settled.total - settled.footer
    const trimmed = settled.footer

    // After the sign-offs and the footer, which read the raw text
    const typed = await settleColumns(conn, columns, reading, inferred)
    columns = typed.columns

    // Both paths, one number: which of them took a row is this file's business,
    // and a reader comparing the table against the download only wants to know
    // that something is not here. Only the reader's refusals can be located,
    // though — a row trimmed from the table cannot be traced back to a line of
    // the file, since blank lines and quoted newlines are gone by then.
    const droppedRows = dropped.count + trimmed
    const { described, rowGroupRows, profile } = await writeTable(
      conn,
      columns,
      rowCount,
      parquetPath,
      profileRequest
    )
    return {
      rowGroupRows,
      ...(profile && { profile }),
      schema: {
        columns: withSettledNotes(described, typed.notes),
        rowCount,
        ...(typed.missing.length > 0 && { missingSettled: typed.missing }),
        ...(droppedRows > 0 && { droppedRows }),
        ...(dropped.lines.length > 0 && {
          droppedLines: dropped.lines,
          dialect: dropped.dialect,
        }),
        ...(lenient && { lenient }),
      },
    }
  } catch (err) {
    if (isOutOfMemory(err)) return { schema: { rowCount: 0, columns: [] }, reason: 'out-of-memory' }
    throw err
  } finally {
    // A worker leaking an instance per message accumulates its buffer manager
    // and threads for days.
    await close()
  }
}

/** The reader could not settle on a dialect, before it read a single row. */
const SNIFF_FAILED = /Error when sniffing file/

/**
 * Load the file into `t`, and say whether the reader had to be let off the
 * standard to do it.
 *
 * Read to the standard first. Where the sniffer cannot settle on a dialect at
 * all — measured on line endings mixed within one file, and on a quote left
 * bare inside a quoted cell — no option that keeps the standard gets it
 * further: `ignore_errors` is about rows, and this fails before there are any.
 * `strict_mode = false` reads both, so it is tried second, and only then,
 * because it also changes what a refusal is: a row with too many fields is
 * cut to width and **not** recorded in `reject_errors`, where the standard
 * reader refuses and counts it. A file that reads to the standard is read no
 * differently than before; one that does not is read rather than failed, and
 * the schema says so.
 *
 * The standard reader *can* isolate such a row (`UNQUOTED VALUE`) if the
 * dialect is pinned with `auto_detect = false` — measured — but that also
 * pins every column to a declared type, and typing is what the sniff is for.
 */
async function load(conn: DuckDBConnection, csvPath: string, skipRows: number): Promise<boolean> {
  try {
    await conn.run(
      `CREATE TABLE t AS SELECT * FROM read_csv(${readOptions(csvPath, skipRows, [], false)})`
    )
    return false
  } catch (e) {
    if (!(e instanceof Error) || !SNIFF_FAILED.test(e.message)) throw e
  }
  await conn.run(
    `CREATE TABLE t AS SELECT * FROM read_csv(${readOptions(csvPath, skipRows, [], true)})`
  )
  return true
}

const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase())

/** A column name without the byte order mark a first read can leave on it. */
const withoutMark = (name: string) => name.replace(/^\uFEFF+/, '')

/**
 * Take the byte-order marks off the first column's name.
 *
 * `read_csv` strips one BOM from the file. A file that carries two — a round
 * trip through Excel produces them — keeps the second in its first column's
 * name, where it is invisible in every listing and stops the column from
 * matching its own name in the next version of the file (a primary key is a
 * column name, ADR-043). Left alone when the bare name is empty or already
 * taken; the mark is then the column's name.
 */
async function stripByteOrderMark(conn: DuckDBConnection, columns: Column[]): Promise<Column[]> {
  const [first, ...rest] = columns
  if (!first) return columns
  const name = withoutMark(first.name)
  if (name === first.name || name === '') return columns
  // Taken on DuckDB's terms: identifiers compare case-insensitively even when
  // quoted, and its folding covers ASCII only — `foo` and `FOO` are one name,
  // `äbc` and `ÄBC` are two.
  const taken = rest.some((c) => asciiLower(c.name) === asciiLower(name))
  if (taken) return columns
  await conn.run(
    `ALTER TABLE t RENAME COLUMN ${sqlIdentifier(first.name)} TO ${sqlIdentifier(name)}`
  )
  return [{ ...first, name }, ...rest]
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
 * Columns whose values the sniffed type refused, on lines refused for nothing
 * else.
 *
 * The sniffer decides a type from values that the load then fails to cast:
 * `- ` passes as an integer while it chooses, and a later `15.5` makes the
 * column DOUBLE, which `- ` is not (duckdb/duckdb#26532). Every such line would
 * be dropped and the table refused for rows it has. Read as text, they are rows.
 *
 * A line refused for its shape as well is not counted: a sign-off `出典: 港区`
 * fails the cast of the first column *and* is short, and is judged as the note
 * it is (`rejectedLines`) rather than turning that column into text.
 */
async function castRefusedColumns(conn: DuckDBConnection, columns: Column[]): Promise<string[]> {
  const rows = (
    await conn.runAndReadAll(`
      SELECT DISTINCT column_name FROM reject_errors e
      WHERE error_type = 'CAST' AND NOT EXISTS (
        SELECT 1 FROM reject_errors o
        WHERE o.scan_id = e.scan_id AND o.line = e.line AND o.error_type <> 'CAST'
      )
    `)
  ).getRowObjectsJson() as { column_name: string }[]
  // A name the binding decoded differently is not one `types` can take
  const names = new Set(columns.map((c) => c.name))
  return rows.map((r) => r.column_name).filter((name) => names.has(name))
}

/**
 * Integer columns holding a cell DuckDB read as 0 from a sign alone.
 *
 * `- ` casts to 0 as an integer, where `-` fails (duckdb/duckdb#26532), so a
 * count written `- ` for "none" is published as a zero, without a refusal to
 * show for it. Only a column holding a 0 can have one, which answers most
 * files without reading them again. The rest are read once more with those
 * columns as text, by the same reader: a cell is what it parses, quotes and
 * newlines inside them included.
 */
async function signOnlyColumns(
  conn: DuckDBConnection,
  csvPath: string,
  skipRows: number,
  lenient: boolean,
  columns: Column[]
): Promise<string[]> {
  const integers = columns.filter((c) => semanticType(c.duckType) === 'integer')
  if (integers.length === 0) return []
  // The zeros are counted on the rows read so far, so where the first read
  // refused some — rows a re-read may bring back — every integer column is
  // looked at.
  const [{ refused }] = (
    await conn.runAndReadAll('SELECT count(*) > 0 AS refused FROM reject_errors')
  ).getRowObjectsJson() as { refused: boolean }[]
  const zeroCounts = refused ? null : await countEach(conn, 'FROM t', integers, (c) => `${c} = 0`)
  const zeros = zeroCounts ? integers.filter((_, i) => zeroCounts[i] > 0) : integers
  if (zeros.length === 0) return []

  // Not stored as refusals: this read only looks, and what it refuses the
  // first refused already
  const opts = readOptions(
    csvPath,
    skipRows,
    zeros.map((c) => c.name),
    lenient,
    false
  )
  const signCounts = await countEach(
    conn,
    `FROM read_csv(${opts})`,
    zeros,
    (c) => `regexp_full_match(${c}, '\\s*[-+]\\s+')`
  )
  return zeros.filter((_, i) => signCounts[i] > 0).map((c) => c.name)
}

/** How many rows of `from` meet `where` for each column, in one pass. */
async function countEach(
  conn: DuckDBConnection,
  from: string,
  columns: Column[],
  where: (column: string) => string
): Promise<number[]> {
  const reader = await conn.runAndReadAll(
    `SELECT ${columns
      .map((c, i) => `count(*) FILTER (WHERE ${where(sqlIdentifier(c.name))}) AS c${i}`)
      .join(', ')} ${from}`
  )
  const [row] = reader.getRowObjectsJson() as Record<string, unknown>[]
  return columns.map((_, i) => Number(row[`c${i}`]))
}

/**
 * Rows `read_csv` refused, counted by line.
 *
 * One row that does not fit files an error per column it could not fill, so the
 * distinct lines are the rows. Read after the last load, whose refusals are the
 * only ones left: a re-read clears the first's, which the types it changed may
 * have answered.
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
): Promise<{ count: number; lines: number[]; dialect?: CsvDialect; notes: LineShape[] | null }> {
  const [{ n }] = (
    await conn.runAndReadAll('SELECT count(DISTINCT line) AS n FROM reject_errors')
  ).getRowObjectsJson() as { n: number }[]
  if (Number(n) === 0) return { count: 0, lines: [], notes: [] }

  // Read once and carried out on the schema: the refused lines are numbered
  // under this dialect, and a reader counting the file any other way puts
  // those numbers on the wrong lines.
  const [dialect] = (
    await conn.runAndReadAll('SELECT delimiter, quote, escape FROM reject_scans LIMIT 1')
  ).getRowObjectsJson() as unknown as CsvDialect[]

  const rows = (
    await conn.runAndReadAll(
      `SELECT DISTINCT line FROM reject_errors ORDER BY line LIMIT ${DROPPED_LINE_SAMPLE}`
    )
  ).getRowObjectsJson() as { line: number }[]
  return {
    count: Number(n),
    lines: rows.map((row) => Number(row.line)),
    dialect,
    notes: await refusedShapes(conn, columns, dialect, Number(n)),
  }
}

/**
 * The shapes of the lines the reader refused, each once, or null when one of
 * them does not read as a sign-off.
 *
 * The rule itself is `csv-sign-off.ts`; this fetches what it needs. The lines
 * come back as text because counting their values is a parser's job — the file
 * this exists for quotes every cell — and in batches because a file can be
 * refused from end to end. **Every refused line is judged**, not a sample of
 * them: how many the schema carries out to a reader is a separate question, and
 * a file with one more note than that must not become a different file. What
 * the table says of them is asked once, of their shapes, in {@link settleSignOffs}.
 *
 * The walk stops at the first line that is not a sign-off, which is every case
 * but the one where they all are.
 */
async function refusedShapes(
  conn: DuckDBConnection,
  columns: Column[],
  dialect: CsvDialect,
  count: number
): Promise<LineShape[] | null> {
  const shapes = new Map<string, LineShape>()
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

    for (const row of rows) {
      const shape =
        row.csv_line === null ? null : refusedLineShape(row.csv_line, dialect, columns.length)
      if (shape === null) return null
      shapes.set(shape.join(), shape)
    }
  }
  return [...shapes.values()]
}

/**
 * Find the trailing run of footer rows, and whether a refused line the table
 * vouches for makes the file one with a broken row.
 *
 * A row is a footer on the same terms a refused line is a sign-off: it carries
 * at most `SIGN_OFF_MAX_CELLS` values, and at least
 * `SIGN_OFF_MIN_MISSING` fewer than the table has columns. The two paths
 * see the same note written two ways — `出典: 港区,2026` is refused by the
 * reader, and the same note padded out to the width arrives here as a row of
 * mostly empty cells — so they answer with one rule, or the publisher's choice
 * about trailing commas decides what the table holds.
 *
 * The distance is what makes it a rule about the table rather than about
 * emptiness: a two-column file whose last row is `a,` is a row, and used to be
 * dropped for being half blank.
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
 *
 * **A sparse row shaped like the rows above it is a row.** The shape alone
 * cannot tell a note from a table whose rows are mostly blank: a list of
 * prefectures where only some have a second URL or a date has rows of three
 * values in seven columns, and the last two were dropped because they happened
 * to be the sparse ones. The rows above the run are what both the run and the
 * refused lines are measured against, once, and the footer starts below the
 * lowest row of the run the table vouches for ({@link vouches}). A refused line
 * it vouches for is a row of the table that broke.
 */
async function settleSignOffs(
  conn: DuckDBConnection,
  columns: Column[],
  refused: LineShape[]
): Promise<{ total: number; footer: number; brokenRow: boolean }> {
  const [{ n }] = (await conn.runAndReadAll('SELECT count(*) AS n FROM t')).getRowObjectsJson() as {
    n: number
  }[]
  const total = Number(n)
  if (total === 0) return { total, footer: 0, brokenRow: false }

  const tail = (
    await conn.runAndReadAll(`
      SELECT [${columns.map((c) => `CAST(${sqlIdentifier(c.name)} AS VARCHAR)`).join(', ')}] AS cells
      FROM (SELECT *, row_number() OVER () AS rn FROM t)
      WHERE rn > ${Math.max(0, total - CSV_FOOTER_SCAN_ROWS)}
      ORDER BY rn DESC
    `)
  ).getRowObjectsJson() as { cells: (string | null)[] }[]
  const run: LineShape[] = []
  for (const { cells } of tail) {
    const shape = signOffShape(cells, columns.length)
    if (shape === null) break
    run.push(shape)
  }

  // A run from the top is the table, sparse throughout — a table of two used
  // columns in six — not a footer with nothing above it; a refused line is
  // still measured against it, every row being a row
  const above = total - run.length
  if (above === 0) {
    const body = await tableBody(conn, columns, total, refused)
    return { total, footer: 0, brokenRow: refused.some((shape) => vouches(body, shape)) }
  }
  if (run.length === 0 && refused.length === 0) return { total, footer: 0, brokenRow: false }

  const body = await tableBody(conn, columns, above, [...refused, ...run])
  const lowestRow = run.findIndex((shape) => vouches(body, shape))
  return {
    total,
    footer: lowestRow < 0 ? run.length : lowestRow,
    brokenRow: refused.some((shape) => vouches(body, shape)),
  }
}

/** A cell as the table holds it, trimmed as `cellValue` trims a line's; blank as null. */
const cellSql = (name: string) =>
  `nullif(trim(CAST(${sqlIdentifier(name)} AS VARCHAR), ${sqlLiteral(CELL_BLANKS)}), '')`

/** `CellShape` in SQL, of a cell already read by {@link cellSql}. */
function shapeSql(expr: string): string {
  const arms = CELL_SHAPES.map(
    ([shape, re]) => `WHEN regexp_full_match(${expr}, ${sqlLiteral(re)}) THEN '${shape}'`
  ).join(' ')
  return `CASE WHEN ${expr} IS NULL THEN NULL ${arms} ELSE 'text' END`
}

/**
 * What the first `rows` rows of the table say about `lines` ({@link TableBody}):
 * only their masks are looked for and only the columns they fill are shaped,
 * so one scan answers every line however many were refused.
 */
async function tableBody(
  conn: DuckDBConnection,
  columns: Column[],
  rows: number,
  lines: LineShape[]
): Promise<TableBody> {
  const asked = new Map<number, Set<CellShape>>()
  for (const line of lines) {
    line.forEach((shape, i) => {
      if (shape !== null && i < columns.length) asked.set(i, (asked.get(i) ?? new Set()).add(shape))
    })
  }
  const body: TableBody = { masks: new Set(), columns: new Map() }
  if (asked.size === 0) return body

  const masks = [...new Set(lines.map(maskOf))]
  const mask = columns.map((_, i) => `CASE WHEN v${i} IS NULL THEN '0' ELSE '1' END`).join(' || ')
  const measures = [
    `list(DISTINCT m) FILTER (WHERE m IN (${masks.map(sqlLiteral).join(', ')})) AS masks`,
    ...[...asked].flatMap(([i, shapes]) => [
      `count(s${i}) AS n${i}`,
      ...[...shapes].map((s) => `count(*) FILTER (WHERE s${i} = '${s}') AS "${s}${i}"`),
    ]),
  ]
  const [row] = (
    await conn.runAndReadAll(`
      SELECT ${measures.join(', ')} FROM (
        SELECT ${mask} AS m, ${[...asked.keys()].map((i) => `${shapeSql(`v${i}`)} AS s${i}`).join(', ')}
        FROM (SELECT ${columns.map((c, i) => `${cellSql(c.name)} AS v${i}`).join(', ')} FROM t LIMIT ${rows})
      )
    `)
  ).getRowObjectsJson() as Record<string, unknown>[]

  for (const m of (row.masks as string[] | null) ?? []) body.masks.add(m)
  for (const [i, shapes] of asked) {
    body.columns.set(i, {
      values: Number(row[`n${i}`]),
      shapes: new Map([...shapes].map((s) => [s, Number(row[`${s}${i}`])])),
    })
  }
  return body
}

/** Drop the last `footer` rows of the table. */
async function cutFooter(conn: DuckDBConnection, total: number, footer: number): Promise<void> {
  // Rewritten rather than deleted by row number: `row_number()` has no stable
  // meaning across statements, so the cut has to happen inside the one that
  // computed it.
  await conn.run(`CREATE OR REPLACE TABLE t AS
    SELECT * EXCLUDE (rn) FROM (SELECT *, row_number() OVER () AS rn FROM t) WHERE rn <= ${total - footer}`)
}
