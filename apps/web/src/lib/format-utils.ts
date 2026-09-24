import type { ResourceColumnType } from '@kukan/shared'
import type { FieldType } from '@/hooks/use-parquet-schema'

/**
 * Format a byte count as a human-readable string (e.g. "1.2 MB").
 * Returns null for null/undefined/negative values.
 */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || bytes < 0) return null
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/**
 * Render one cell of a tabular preview.
 *
 * Typed columns arrive as JS values rather than text now that the preview is
 * written from DuckDB's own types (ADR-046): `String()` on a Date gives
 * "Thu Apr 01 2023 09:00:00 GMT+0900 (…)" where the file said `2023-04-01`, and
 * a 64-bit integer arrives as a BigInt. Dates are shown in ISO form — what the
 * source CSV most often held, and unambiguous whatever the reader's locale.
 *
 * Shared by both readers of the preview Parquet: hyparquet renders the first
 * page, DuckDB-WASM the explorer (ADR-016). They read the same file, so a
 * column typed one way must not read two ways on screen — which is also why
 * `type` is worth passing: both readers know it, and without it a timestamp at
 * midnight is indistinguishable from a date.
 */
export function formatCell(value: unknown, type?: FieldType | ResourceColumnType): string {
  if (value == null) return ''
  if (value instanceof Date) {
    const iso = value.toISOString()
    const day = iso.slice(0, 10)
    const moment = iso.slice(0, 19).replace('T', ' ')
    // **The column decides, not the value.** A DATE has no time of day to show
    // and comes back as midnight UTC; a TIMESTAMP that happens to fall on
    // midnight still has one, and reading it off the value shortened exactly
    // those rows — one column rendering two ways down the page.
    if (type === 'date') return day
    if (type === 'datetime' || type === 'timestamp') return moment
    // Nothing to go on: midnight is the better guess at a DATE, and a caller
    // that knows the type does not come through here.
    return iso.endsWith('T00:00:00.000Z') ? day : moment
  }
  return String(value)
}

/**
 * The message key naming a column's type on screen.
 *
 * **One map for two vocabularies.** The Parquet footer reports its own set
 * (`number`, `datetime`) and ADR-029's inference reports another (`float`,
 * `timestamp`), and the same column is shown through both — the resource page
 * reads the footer, the primary-key picker reads the version's frozen schema.
 * Named separately they would drift, and a reader comparing the two screens
 * would be told the column is two different things.
 *
 * Exhaustive on purpose: a type added to either vocabulary has to be given a
 * name here before it compiles.
 */
const COLUMN_TYPE_KEY: Record<FieldType | ResourceColumnType, string> = {
  string: 'fieldTypeString',
  integer: 'fieldTypeInteger',
  number: 'fieldTypeNumber',
  float: 'fieldTypeNumber',
  boolean: 'fieldTypeBoolean',
  date: 'fieldTypeDate',
  datetime: 'fieldTypeDatetime',
  timestamp: 'fieldTypeDatetime',
}

/** @see COLUMN_TYPE_KEY */
export function columnTypeKey(type: FieldType | ResourceColumnType): string {
  return COLUMN_TYPE_KEY[type]
}
