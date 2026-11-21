/**
 * Read a table's settled columns on the types a person settled (Versioning
 * ii-c §8.3).
 *
 * The columns arrive as text — the CSV reader is told to read them as VARCHAR,
 * the JSON reader hands them over as their written form — and are rebuilt here
 * with `TRY_CAST`, after everything that has to see the raw text (the sign-off
 * and footer rules). Reading them on the type directly would have the reader
 * refuse every row holding one value that does not convert, and with it the
 * whole file; a value that does not convert is left empty instead, counted and
 * shown, and the row stays.
 */
import type { DuckDBConnection } from '@duckdb/node-api'
import { sqlIdentifier, sqlLiteral } from '@kukan/lake'
import {
  ISO_8601_TIMESTAMP,
  parseSettledType,
  settledTypesOf,
  SETTLED_DATE_FORMATS,
  SETTLED_TIMESTAMP_FORMATS,
  type ResourceColumn,
  type ResourceColumnType,
  type ResourceSchema,
  type SettledTypeSpec,
} from '@kukan/shared'
import { freeRowid } from './table-profile'
import { describe, type Column } from './write-table'

/** What the previous version decided about a settled column. */
export type PreviousRead = Pick<
  ResourceColumn,
  'dateFormat' | 'dateFormatUndecided' | 'decimalPrecision' | 'decimalScale'
>

/** What a version is read with: the settled types, and what the previous version decided. */
export interface SettledReading {
  /** Column name → the stored settled type (`"decimal"`, `"date:%d/%m/%Y"`). */
  types: Record<string, string>
  /**
   * What the previous version read these columns with, by name: a date format
   * that breaks a tie, and digits to fall back on where no value is readable.
   */
  previous?: Record<string, PreviousRead>
  /**
   * Read with what `previous` decided rather than falling back on it: the
   * version is being read again as it was read once — by the lake, which has
   * to load the table its preview shows — or as the version a revert goes
   * back to was read (§8.2). A column `previous` has nothing for is decided
   * from its values.
   */
  fixed?: true
}

/** What a schema's columns decided that a later reading falls back on, by name. */
export function previousReads(schema: ResourceSchema): Record<string, PreviousRead> {
  const reads: Record<string, PreviousRead> = {}
  for (const c of schema.columns) {
    if (c.dateFormat === undefined && !c.dateFormatUndecided && c.decimalPrecision === undefined) {
      continue
    }
    reads[c.name] = {
      ...(c.dateFormat !== undefined && { dateFormat: c.dateFormat }),
      ...(c.dateFormatUndecided && { dateFormatUndecided: true as const }),
      ...(c.decimalPrecision !== undefined && {
        decimalPrecision: c.decimalPrecision,
        decimalScale: c.decimalScale,
      }),
    }
  }
  return reads
}

/**
 * The reading for `types`, falling back on what `schema` decided — or, where
 * `fixed`, reading with it (§8.3).
 */
export function readingOf(
  types: Record<string, string>,
  schema: ResourceSchema | null,
  fixed?: true
): SettledReading {
  return { types, ...(schema && { previous: previousReads(schema), ...(fixed && { fixed }) }) }
}

/**
 * How to read a version with its frozen settled types: again as it was read,
 * with the formats and digits its schema records — or, where no reading has
 * recorded one, for the first time, falling back on the schema of the version
 * before it. Undefined where it froze none.
 */
export function versionReading(
  settledTypes: Record<string, string> | null,
  schema: ResourceSchema | null,
  previousSchema: ResourceSchema | null
): SettledReading | undefined {
  const types = settledTypesOf(settledTypes)
  if (!types) return undefined
  return schema ? readingOf(types, schema, true) : readingOf(types, previousSchema)
}

/** What a settled column adds to its schema entry. */
export type SettledNote = Pick<
  ResourceColumn,
  | 'settled'
  | 'inferredType'
  | 'castFailures'
  | 'castFailureSamples'
  | 'dateFormat'
  | 'dateFormatUndecided'
  | 'decimalPrecision'
  | 'decimalScale'
>

/** Values sampled where a column did not convert, and how much of each is kept. */
const SAMPLES = 10
const SAMPLE_CHARS = 100
/** DuckDB's widest decimal, and its default where nothing decides the digits. */
const MAX_DIGITS = 38
const DEFAULT_DECIMAL = { precision: 18, scale: 3 }

/** A whole value written with commas every three digits (`1,234,567.8`). */
const GROUPED = String.raw`[+-]?\d{1,3}(,\d{3})+(\.\d+)?`
/** A plain decimal number, the only shape a `decimal` takes. */
const PLAIN_DECIMAL = String.raw`[+-]?(\d+(\.\d+)?|\.\d+)`

/**
 * The settled columns `types` names that the table has, by the name the table
 * gives them. A name the table does not have is the caller's `missingSettled`.
 */
function settledSpecs(
  types: Record<string, string>,
  names: string[]
): Map<string, SettledTypeSpec> {
  const specs = new Map<string, SettledTypeSpec>()
  for (const name of names) {
    if (!Object.hasOwn(types, name)) continue
    const spec = parseSettledType(types[name])
    if (spec) specs.set(name, spec)
  }
  return specs
}

/** What reading the settled columns came to. */
export interface Settled {
  /** The table's columns as they now are. */
  columns: Column[]
  /** What each settled column came to, by name. */
  notes: Map<string, SettledNote>
  /** Settled names the table does not have (§8.3 step 1), sorted. */
  missing: string[]
}

/**
 * Rebuild table `t`'s settled columns on their types, and say what each one
 * came to. The columns must be text in `t`. Without `reading`, or with no
 * settled column in the table, nothing is read.
 *
 * @param inferred - what inference made of each settled column, by name.
 */
export async function settleColumns(
  conn: DuckDBConnection,
  columns: Column[],
  reading: SettledReading | undefined,
  inferred: Map<string, ResourceColumnType>
): Promise<Settled> {
  const types = reading?.types ?? {}
  const names = columns.map((c) => c.name)
  const missing = Object.keys(types)
    .filter((name) => !names.includes(name))
    .sort()
  const specs = settledSpecs(types, names)
  const notes = new Map<string, SettledNote>()
  if (specs.size === 0) return { columns, notes, missing }

  // The samples are numbered by DuckDB's rowid, which a column of that name hides
  const reachable = await freeRowid(conn, names)
  const at = new Map(names.map((name, i) => [name, sqlIdentifier(reachable[i])]))
  const exprs = new Map<string, string>()
  for (const [name, spec] of specs) {
    const col = at.get(name)!
    const previous =
      reading?.previous && Object.hasOwn(reading.previous, name)
        ? reading.previous[name]
        : undefined
    const fixed = reading?.fixed === true
    // Read with the format the version was read with, as if the setting named it
    const read = await readExpression(
      conn,
      col,
      fixed && previous?.dateFormat && !spec.format
        ? { ...spec, format: previous.dateFormat }
        : spec,
      previous,
      fixed
    )
    if (read.expr !== null) exprs.set(name, read.expr)
    notes.set(name, {
      settled: true,
      inferredType: inferred.get(name) ?? 'string',
      ...read.note,
      ...(read.expr !== null && (await failures(conn, col, read.expr))),
    })
  }
  const renamed = reachable.some((name, i) => name !== names[i])
  if (exprs.size === 0 && !renamed) return { columns, notes, missing }

  // A new table rather than an ALTER per column: one pass, the rows in the
  // order they were in, and a column moved out of rowid's way named back
  const select = names
    .map((name) => `${exprs.get(name) ?? at.get(name)} AS ${sqlIdentifier(name)}`)
    .join(', ')
  await conn.run(`CREATE TABLE t_settled AS SELECT ${select} FROM t`)
  await conn.run('DROP TABLE t')
  await conn.run('ALTER TABLE t_settled RENAME TO t')
  return { columns: await describe(conn), notes, missing }
}

/** The one row a query of aggregates returns. */
async function firstRow<T>(conn: DuckDBConnection, sql: string): Promise<T> {
  return (await conn.runAndReadAll(sql)).getRowObjectsJS()[0] as T
}

/** The value with the spaces around it gone, as the reader drops them for a number or date. */
const trimmed = (col: string) => `trim(${col})`

/** The value ready for a number cast: commas taken out only where they group every three digits. */
const numeric = (col: string) =>
  `CASE WHEN regexp_full_match(${trimmed(col)}, ${sqlLiteral(GROUPED)}) ` +
  `THEN replace(${trimmed(col)}, ',', '') ELSE ${trimmed(col)} END`

/**
 * The expression a settled column is read with, or null where it stays as it
 * was read — a `string`, or a date whose format cannot be told.
 */
async function readExpression(
  conn: DuckDBConnection,
  col: string,
  spec: SettledTypeSpec,
  previous: PreviousRead | undefined,
  fixed: boolean
): Promise<{ expr: string | null; note: SettledNote }> {
  switch (spec.type) {
    case 'string':
      // Not trimmed: text read as VARCHAR keeps the spaces inside quotes, and
      // taking them off would change the value without saying so
      return { expr: null, note: {} }
    case 'integer':
      // Shape first: DuckDB casts `1.5` to `2` without failing, and a rounded
      // value would publish with nothing counted against it
      return {
        expr: `CASE WHEN regexp_full_match(${numeric(col)}, '[+-]?\\d+') THEN TRY_CAST(${numeric(col)} AS BIGINT) END`,
        note: {},
      }
    case 'float':
      return { expr: `TRY_CAST(${numeric(col)} AS DOUBLE)`, note: {} }
    case 'boolean':
      return { expr: `TRY_CAST(${trimmed(col)} AS BOOLEAN)`, note: {} }
    case 'decimal':
      return decimalExpression(conn, col, previous, fixed)
    case 'date':
    case 'timestamp':
      return dateExpression(conn, col, spec, previous, fixed)
  }
}

/**
 * A `decimal` column's digits, decided from its values (§8.3): the most
 * fraction digits, and the most integer digits beside them, up to 38 in all.
 * A value past 38 digits decides nothing and fails; where the two maxima do not
 * fit together, the integer part wins and the fraction is shortened, so a long
 * fraction fails rather than a large value becoming unreadable.
 */
async function decimalExpression(
  conn: DuckDBConnection,
  col: string,
  previous: PreviousRead | undefined,
  fixed: boolean
): Promise<{ expr: string; note: SettledNote }> {
  const value = numeric(col)
  // Leading zeros take no digit, as in DuckDB: `007` is one digit, `0.5` none
  const intDigits = `length(ltrim(regexp_extract(${value}, '^[+-]?(\\d*)', 1), '0'))`
  const fracDigits = `length(regexp_extract(${value}, '\\.(\\d+)$', 1))`
  const plain = `regexp_full_match(${value}, ${sqlLiteral(PLAIN_DECIMAL)})`
  let precision: number
  let scale: number
  if (fixed && previous?.decimalPrecision !== undefined && previous.decimalScale !== undefined) {
    precision = previous.decimalPrecision
    scale = previous.decimalScale
  } else {
    const row = await firstRow<{ i: number | bigint | null; f: number | bigint | null }>(
      conn,
      `SELECT max(i) AS i, max(f) AS f FROM (SELECT ${intDigits} AS i, ${fracDigits} AS f FROM t WHERE ${plain}) WHERE i + f <= ${MAX_DIGITS}`
    )
    if (row.i == null || row.f == null) {
      // Nothing readable decides the digits: the previous version's, or DuckDB's default
      precision = previous?.decimalPrecision ?? DEFAULT_DECIMAL.precision
      scale = previous?.decimalScale ?? DEFAULT_DECIMAL.scale
    } else {
      const ints = Number(row.i)
      scale = Math.min(Number(row.f), MAX_DIGITS - ints)
      precision = Math.max(1, ints + scale)
    }
  }
  const fits = `${plain} AND ${intDigits} <= ${precision - scale} AND ${fracDigits} <= ${scale}`
  return {
    // Only a value that fits: TRY_CAST would round a long fraction without failing
    expr: `CASE WHEN ${fits} THEN TRY_CAST(${value} AS DECIMAL(${precision}, ${scale})) END`,
    note: { decimalPrecision: precision, decimalScale: scale },
  }
}

/**
 * A `date` or `timestamp` column's format: the setting's, or the candidate
 * reading the most values (§8.3). A tie goes to the previous version's format;
 * a tie the formats agree on goes to the first; a tie on different dates, with
 * no previous format, is left undecided and the column stays text, since a
 * guess would publish days and months swapped with nothing counted against it.
 */
async function dateExpression(
  conn: DuckDBConnection,
  col: string,
  spec: SettledTypeSpec,
  previous: PreviousRead | undefined,
  fixed: boolean
): Promise<{ expr: string | null; note: SettledNote }> {
  const cast = spec.type === 'date' ? 'DATE' : 'TIMESTAMP'
  // `%Y` takes two digits too, and would read `26-11-21` as the year 26
  // Seconds with or without a fraction, as one format: a column that has both
  // would otherwise split between two candidates and lose either half
  const parse = (format: string) =>
    format.endsWith('%S')
      ? `coalesce(try_strptime(${trimmed(col)}, ${sqlLiteral(format)}), try_strptime(${trimmed(col)}, ${sqlLiteral(`${format}.%f`)}))`
      : `try_strptime(${trimmed(col)}, ${sqlLiteral(format)})`
  const read = (format: string) =>
    format === ISO_8601_TIMESTAMP
      ? isoTimestamp(trimmed(col))
      : format.includes('%Y')
        ? `CASE WHEN regexp_matches(${trimmed(col)}, '\\d{4}') THEN ${parse(format)}::${cast} END`
        : `${parse(format)}::${cast}`
  if (spec.format) return { expr: read(spec.format), note: { dateFormat: spec.format } }
  if (fixed && previous?.dateFormatUndecided)
    return { expr: null, note: { dateFormatUndecided: true } }

  const candidates: readonly string[] =
    spec.type === 'date' ? SETTLED_DATE_FORMATS : SETTLED_TIMESTAMP_FORMATS
  const counts = await firstRow<Record<string, number | bigint>>(
    conn,
    `SELECT ${candidates.map((f, i) => `count(${read(f)}) AS c${i}`).join(', ')} FROM t`
  )
  const reads = candidates.map((_, i) => Number(counts[`c${i}`]))
  const best = Math.max(...reads)
  const tied = candidates.filter((_, i) => reads[i] === best)
  if (best === 0 || tied.length === 1) {
    // The previous format only where it is one of this type's: a column settled
    // from `timestamp` to `date` cannot read a time of day's format
    const format =
      best === 0 && previous?.dateFormat && candidates.includes(previous.dateFormat)
        ? previous.dateFormat
        : tied[0]
    return { expr: read(format), note: { dateFormat: format } }
  }
  if (previous?.dateFormat && tied.includes(previous.dateFormat)) {
    return { expr: read(previous.dateFormat), note: { dateFormat: previous.dateFormat } }
  }
  const [first, ...rest] = tied
  const { n: disagree } = await firstRow<{ n: number | bigint }>(
    conn,
    `SELECT count(*) AS n FROM t WHERE ${rest
      .map((f) => `${read(first)} IS DISTINCT FROM ${read(f)}`)
      .join(' OR ')}`
  )
  if (Number(disagree) === 0) return { expr: read(first), note: { dateFormat: first } }
  return { expr: null, note: { dateFormatUndecided: true } }
}

/** An ISO 8601 date and time, and the offset at its end where it has one. */
const ISO_SHAPE = String.raw`\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?`
const OFFSET = String.raw`(Z|[+-]\d{2}(:?\d{2})?)$`

/**
 * An ISO 8601 value as a TIMESTAMP: as written where it has no offset, and in
 * UTC where it has one, so values written in different offsets compare as the
 * instants they are. Not read in the session's zone, which differs between a
 * developer's machine and the worker.
 */
const isoTimestamp = (value: string) =>
  `CASE WHEN regexp_full_match(${value}, ${sqlLiteral(ISO_SHAPE)}) THEN ` +
  `CASE WHEN regexp_matches(${value}, ${sqlLiteral(OFFSET)}) ` +
  `THEN TRY_CAST(${value} AS TIMESTAMPTZ) AT TIME ZONE 'UTC' ` +
  `ELSE TRY_CAST(${value} AS TIMESTAMP) END END`

/** How many values the expression left empty that were not, and the first of them. */
async function failures(
  conn: DuckDBConnection,
  col: string,
  expr: string
): Promise<Pick<SettledNote, 'castFailures' | 'castFailureSamples'>> {
  const failed = `${trimmed(col)} <> '' AND (${expr}) IS NULL`
  const reader = await conn.runAndReadAll(
    `SELECT rowid AS r, ${col}::VARCHAR AS v, count(*) OVER () AS n FROM t WHERE ${failed} ORDER BY rowid LIMIT ${SAMPLES}`
  )
  const rows = reader.getRowObjectsJS() as { r: number | bigint; v: string; n: number | bigint }[]
  if (rows.length === 0) return {}
  return {
    castFailures: Number(rows[0].n),
    castFailureSamples: rows.map((row) => ({
      row: Number(row.r) + 1,
      value: row.v.length > SAMPLE_CHARS ? row.v.slice(0, SAMPLE_CHARS) : row.v,
    })),
  }
}

/** The schema's columns with what each settled one came to. */
export function withSettledNotes(
  described: ResourceColumn[],
  notes: Map<string, SettledNote>
): ResourceColumn[] {
  return described.map((column) => {
    const note = notes.get(column.name)
    return note ? { ...column, ...note } : column
  })
}
