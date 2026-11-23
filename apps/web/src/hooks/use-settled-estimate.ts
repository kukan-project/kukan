import { useEffect, useRef, useState } from 'react'
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import {
  isExponent,
  isNoValueMark,
  settledExpression,
  settledFailed,
  settledFailures,
  settledMarks,
  type SettledNote,
  type SettledRelation,
} from '@kukan/lake/settled'
import { sqlIdentifier, sqlLiteral } from '@kukan/lake/sql'
import { parseSettledType, type ResourceColumn } from '@kukan/shared'
import { arrowToStringRows, getDB } from '@/hooks/use-duckdb'
import type { DisplayRow } from '@/lib/table-cells'
import { tablePreviewUrl } from '@/lib/paths'
import { cellKey } from '@/components/data-explorer/cell-marks'

/**
 * How many rows from the top of the preview an estimate reads: one of its row
 * groups, so a file of any size costs one ranged read, and every later
 * estimate runs on rows already in memory.
 */
const ESTIMATE_ROWS = 10_000

/** What a chosen type would make of one column, off the rows read. */
export type ColumnEstimate = Omit<SettledNote, 'settled' | 'inferredType'> & {
  /** Values among the rows read, neither blank nor marks: what the failures are a share of */
  values?: number
  /** Of them, values the preview spells in exponent notation: a float too wide for a decimal */
  exponents?: number
}

export interface SettledEstimate {
  /** How many rows the estimate read */
  rows: number
  /** Whether those are all the table has */
  whole: boolean
  columns: Record<string, ColumnEstimate>
  /**
   * Which cells of these rows would not convert, as `cellKey`s — the rows a
   * preview shows, in its own spelling. Judged by the same reading, the
   * formats and digits the estimate decided included, so a cell is marked
   * wherever it sits in the file
   */
  judge(rows: DisplayRow[]): Promise<Set<string>>
}

const DEBOUNCE_MS = 300
/** A row's place in the sample, named apart from the columns */
const SAMPLE_ROW = 'kukan sample row'
/** A name for a row's place in the VALUES a page is judged from */
const ROW_INDEX = '"kukan row index"'

/**
 * What the chosen types would make of the live columns (Versioning ii-c §8.7),
 * worked out in the browser with the rules the worker reads a version by.
 *
 * Off the preview, so an estimate: a value the live version read as a type
 * keeps only that type's spelling. The live reading's formats and digits are
 * where it falls back, as the first reading of the version would. None at all
 * where the preview cannot be read — it is a hint, and a stale or failed one
 * is not shown.
 */
export function useSettledEstimate(input: EstimateInput): SettledEstimate | null {
  return useSettledEstimateState(input).estimate
}

interface EstimateInput {
  resourceId: string
  /** The types to estimate, by column; nothing is read while it is empty */
  types: Record<string, string>
  columns: ResourceColumn[]
  rowCount: number
}

/**
 * {@link useSettledEstimate}, and whether the last try for these inputs failed —
 * for a screen that waits on the estimate, which must not wait on one that
 * will not come.
 */
export function useSettledEstimateState({ resourceId, types, columns, rowCount }: EstimateInput): {
  estimate: SettledEstimate | null
  failed: boolean
} {
  /** The answer, with what it was for: one for other inputs is not shown */
  const [made, setMade] = useState<{
    estimate: SettledEstimate | null
    types: Record<string, string>
    columns: ResourceColumn[]
  } | null>(null)
  const sampleRef = useRef<Promise<{ conn: AsyncDuckDBConnection; rows: number }> | null>(null)

  // DuckDB-WASM started as the tab opens on a table: its tens of megabytes and
  // its start are most of the wait for a first estimate, and a person reading
  // the columns before choosing a type has time for them. A failure is left to
  // the estimate, which tries again
  const hasTable = columns.length > 0
  useEffect(() => {
    if (hasTable) getDB().catch(() => {})
  }, [hasTable])

  // The sample is the resource's: a new one, or a new version under it, reads again
  useEffect(
    () => () => {
      const sample = sampleRef.current
      sampleRef.current = null
      sample?.then(({ conn }) => conn.close()).catch(() => {})
    },
    [resourceId, rowCount, columns]
  )

  useEffect(() => {
    const specs = Object.entries(types).flatMap(([name, type]) => {
      const spec = parseSettledType(type)
      const column = columns.find((c) => c.name === name)
      return spec && column ? [{ name, spec, column }] : []
    })
    if (specs.length === 0) {
      setMade(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      sampleRef.current ??= readSample(resourceId)
      const sample = sampleRef.current
      try {
        const { conn, rows: sampled } = await sample
        const rel: SettledRelation = {
          rows: async (sql) => (await conn.query(sql)).toArray().map((row) => row.toJSON()),
          from: 'settled_sample',
          row: sqlIdentifier(SAMPLE_ROW),
        }
        const out: Record<string, ColumnEstimate> = {}
        const exprs = new Map<string, string>()
        for (const { name, spec, column } of specs) {
          const col = `${sqlIdentifier(name)}::VARCHAR`
          const read = await settledExpression(rel, col, spec, column, false)
          if (read.expr !== null) exprs.set(name, read.expr)
          out[name] = {
            ...read.note,
            ...(read.expr !== null && (await settledFailures(rel, col, read.expr))),
            ...(read.expr !== null && (await settledMarks(rel, col, read.expr))),
            ...(await valuesOf(rel, col)),
          }
          if (cancelled) return
        }
        setMade({
          estimate: {
            rows: sampled,
            whole: sampled >= rowCount,
            columns: out,
            judge: (shown) => judgeCells(conn, exprs, shown),
          },
          types,
          columns,
        })
      } catch {
        // Read again next time, unless a newer sample has taken its place
        if (sampleRef.current === sample) {
          sampleRef.current = null
          sample.then(({ conn }) => conn.close()).catch(() => {})
        }
        if (!cancelled) setMade({ estimate: null, types, columns })
      }
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [resourceId, types, columns, rowCount])

  const current = made && made.types === types && made.columns === columns ? made : null
  return { estimate: current?.estimate ?? null, failed: !!current && !current.estimate }
}

/** How many values of a column are neither blank nor marks alone, and how many of them are in exponent notation. */
async function valuesOf(
  rel: SettledRelation,
  col: string
): Promise<Pick<ColumnEstimate, 'values' | 'exponents'>> {
  const [row] = await rel.rows(
    `SELECT count(*) AS n, count(*) FILTER (WHERE ${isExponent(col)}) AS e FROM ${rel.from} ` +
      `WHERE trim(${col}) <> '' AND NOT ${isNoValueMark(col)}`
  )
  return { values: Number(row.n), exponents: Number(row.e) }
}

/** The cells of rows a preview shows that the expressions leave empty. */
async function judgeCells(
  conn: AsyncDuckDBConnection,
  exprs: Map<string, string>,
  rows: DisplayRow[]
): Promise<Set<string>> {
  const cells = new Set<string>()
  for (const [name, expr] of exprs) {
    if (!(name in rows[0])) continue
    const col = sqlIdentifier(name)
    const values = rows
      .map((row, i) => `(${i}, ${row[name] == null ? 'NULL' : sqlLiteral(row[name])})`)
      .join(', ')
    // The index named apart from the columns, whose names are anyone's
    const failed = await conn.query(
      `SELECT ${ROW_INDEX} AS i FROM (VALUES ${values}) AS v(${ROW_INDEX}, ${col}) ` +
        `WHERE ${settledFailed(`${col}::VARCHAR`, expr)}`
    )
    for (const row of failed.toArray()) cells.add(cellKey(Number(row.toJSON().i), name))
  }
  return cells
}

/** Samples read so far, numbering their files */
let samples = 0

/**
 * The top of the preview, held in memory on a connection of its own. Read by
 * range through the same-origin proxy, so only the footer and the first row
 * group come over the wire, however large the file.
 */
async function readSample(resourceId: string) {
  const db = await getDB()
  // Named apart per read: a screen may hold two estimates reading at once
  const name = `settled-${resourceId}-${++samples}`
  const file = `${name}.parquet`
  const text = `${name}.json`
  const { DuckDBDataProtocol } = await import('@duckdb/duckdb-wasm')
  const url = new URL(tablePreviewUrl(resourceId), location.href)
  await db.registerFileURL(file, url.href, DuckDBDataProtocol.HTTP, false)
  const conn = await db.connect()
  try {
    // Held as the preview spells each value, by the function the preview uses,
    // so the count and the cells marked read one string: DuckDB writes a whole
    // DOUBLE `100.0`, a small one `1e-05`, a DECIMAL `1.500`, none of which a
    // settled integer or decimal would read where the screen's `100` does
    const read = await conn.query(`SELECT * FROM '${file}' LIMIT ${ESTIMATE_ROWS}`)
    const names = read.schema.fields.map((field) => field.name)
    const rows = arrowToStringRows(read, names).map((row, i) => ({ ...row, [SAMPLE_ROW]: i }))
    await db.registerFileText(text, JSON.stringify(rows))
    const columns = [
      ...names.map((name) => `${sqlLiteral(name)}: 'VARCHAR'`),
      `${sqlLiteral(SAMPLE_ROW)}: 'BIGINT'`,
    ]
    await conn.query(
      `CREATE OR REPLACE TEMP TABLE settled_sample AS ` +
        `SELECT * FROM read_json('${text}', columns = {${columns.join(', ')}})`
    )
    return { conn, rows: rows.length }
  } catch (err) {
    await conn.close().catch(() => {})
    throw err
  } finally {
    // The rows are in the temp table: the files, named per read, are let go now
    await db.dropFile(text).catch(() => {})
    await db.dropFile(file).catch(() => {})
  }
}
