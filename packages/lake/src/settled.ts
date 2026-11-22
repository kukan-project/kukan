/**
 * How a settled column is read (Versioning ii-c §8.3), as SQL over a relation.
 *
 * Here rather than with the interpretation, because two places read a column
 * this way and must not read it differently: the worker rebuilds a table on
 * its settled types, and the web estimates, from the live preview, what a type
 * a person is choosing would make of the column. A rule written twice is one
 * an estimate can disagree with.
 *
 * The column arrives as text — an expression a caller makes so — and its value
 * that does not convert comes out empty rather than failing the read.
 */
import {
  ISO_8601_TIMESTAMP,
  SETTLED_DATE_FORMATS,
  SETTLED_TIMESTAMP_FORMATS,
  type ResourceColumn,
  type SettledTypeSpec,
} from '@kukan/shared'
import { sqlLiteral } from './sql'

/** What a reading decided about a settled column on its own: a format, or that it took none, and a decimal's digits. */
export type SettledRead = Pick<
  ResourceColumn,
  'dateFormat' | 'dateFormatUndecided' | 'decimalPrecision' | 'decimalScale'
>

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

/** Where the column is read from, and how its rows are told apart. */
export interface SettledRelation {
  /** A query's rows as objects; numbers may come back as bigints. */
  rows(sql: string): Promise<Record<string, unknown>[]>
  /** The relation, as it stands in a `FROM`. */
  from: string
  /** Each row's number from 0, as an expression over the relation. */
  row: string
}

/** The one row a query of aggregates returns. */
async function firstRow<T>(rel: SettledRelation, sql: string): Promise<T> {
  return (await rel.rows(sql))[0] as T
}

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
export async function settledExpression(
  rel: SettledRelation,
  col: string,
  spec: SettledTypeSpec,
  previous: SettledRead | undefined,
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
      return decimalExpression(rel, col, previous, fixed)
    case 'date':
    case 'timestamp':
      return dateExpression(rel, col, spec, previous, fixed)
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
  rel: SettledRelation,
  col: string,
  previous: SettledRead | undefined,
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
      rel,
      `SELECT max(i) AS i, max(f) AS f FROM (SELECT ${intDigits} AS i, ${fracDigits} AS f FROM ${rel.from} WHERE ${plain}) WHERE i + f <= ${MAX_DIGITS}`
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
  rel: SettledRelation,
  col: string,
  spec: SettledTypeSpec,
  previous: SettledRead | undefined,
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
    rel,
    `SELECT ${candidates.map((f, i) => `count(${read(f)}) AS c${i}`).join(', ')} FROM ${rel.from}`
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
    rel,
    `SELECT count(*) AS n FROM ${rel.from} WHERE ${rest
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
export async function settledFailures(
  rel: SettledRelation,
  col: string,
  expr: string
): Promise<Pick<SettledNote, 'castFailures' | 'castFailureSamples'>> {
  const failed = `${trimmed(col)} <> '' AND (${expr}) IS NULL`
  const rows = (await rel.rows(
    `SELECT ${rel.row} AS r, ${col}::VARCHAR AS v, count(*) OVER () AS n FROM ${rel.from} WHERE ${failed} ORDER BY ${rel.row} LIMIT ${SAMPLES}`
  )) as { r: number | bigint; v: string; n: number | bigint }[]
  if (rows.length === 0) return {}
  return {
    castFailures: Number(rows[0].n),
    castFailureSamples: rows.map((row) => ({
      row: Number(row.r) + 1,
      value: row.v.length > SAMPLE_CHARS ? row.v.slice(0, SAMPLE_CHARS) : row.v,
    })),
  }
}
