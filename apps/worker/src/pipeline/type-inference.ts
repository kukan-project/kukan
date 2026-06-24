/**
 * KUKAN Pipeline — CSV/TSV column type inference (ADR-029)
 *
 * Conservatively infers a column's type from its string values so the Extract
 * step can write typed Parquet. A type is assigned only when EVERY non-empty
 * value matches; anything ambiguous falls back to 'string'. Pure functions —
 * no I/O — so they are straightforward to unit test.
 */

import { BOOLEAN_LITERALS } from '@/config'
import type { ColumnStats, ResourceColumn, ResourceSchema } from '@kukan/shared'

/** Inferred semantic column type. */
export type InferredType = 'integer' | 'float' | 'boolean' | 'string'

/** hyparquet-writer basic type for each inferred type. */
const WRITER_TYPE = {
  integer: 'INT64',
  float: 'DOUBLE',
  boolean: 'BOOLEAN',
  string: 'STRING',
} as const

export type WriterType = (typeof WRITER_TYPE)[InferredType]

/** Value a Parquet cell may hold after conversion. */
export type CellValue = string | bigint | number | boolean | null

const INT_PATTERN = /^-?\d+$/
const FLOAT_PATTERN = /^-?\d+\.\d+$/
const INT64_MAX = 9223372036854775807n
const INT64_MIN = -9223372036854775808n

/** Digits without an optional leading minus sign. */
function unsigned(v: string): string {
  return v.startsWith('-') ? v.slice(1) : v
}

/** Integer pattern with a leading-zero guard ("0" ok, "01234" rejected as a code). */
function isIntegerPattern(v: string): boolean {
  if (!INT_PATTERN.test(v)) return false
  const digits = unsigned(v)
  return !(digits.length > 1 && digits[0] === '0')
}

/** Whether an integer-pattern value fits a signed 64-bit integer. */
function inInt64Range(v: string): boolean {
  const n = BigInt(v)
  return n <= INT64_MAX && n >= INT64_MIN
}

/** Decimal pattern (integer + fractional part) with a leading-zero guard on the integer part. */
function isFloatPattern(v: string): boolean {
  if (!FLOAT_PATTERN.test(v)) return false
  const intPart = unsigned(v).split('.')[0]
  return !(intPart.length > 1 && intPart[0] === '0')
}

function isBooleanLiteral(lower: string): boolean {
  return BOOLEAN_LITERALS.has(lower)
}

/**
 * Infer the column type from all of its string cells. Empty cells ('') are
 * ignored (treated as missing). A column with no non-empty cells is 'string'.
 *
 * Precedence: boolean → integer → float → string. Integers are preferred over
 * floats (narrower type). Integer-pattern columns whose values overflow INT64
 * fall back to 'string' to preserve the exact digits.
 */
export function inferColumnType(values: string[]): InferredType {
  let hasNonEmpty = false
  let allBoolean = true
  let allIntegerPattern = true
  let allInt64 = true
  let allNumeric = true

  for (const v of values) {
    if (v === '') continue
    hasNonEmpty = true

    if (allBoolean && !isBooleanLiteral(v.toLowerCase())) allBoolean = false

    const intPat = isIntegerPattern(v)
    // An integer-pattern value counts as numeric only if it fits INT64. One that
    // overflows must be preserved exactly as a string (a DOUBLE would change its
    // digits), so it disqualifies the column from BOTH integer and float — even
    // when mixed with decimals.
    const inRange = intPat && inInt64Range(v)
    if (allIntegerPattern && !intPat) allIntegerPattern = false
    if (allInt64 && !inRange) allInt64 = false
    if (allNumeric && !(inRange || isFloatPattern(v))) allNumeric = false

    // Once it can be neither boolean nor any numeric type, it must be a string.
    if (!allBoolean && !allNumeric) return 'string'
  }

  if (!hasNonEmpty) return 'string'
  if (allBoolean) return 'boolean'
  // All values are integers by pattern: typed as INT64 only if all fit the range,
  // otherwise string (oversize ids must not lose precision or become DOUBLE).
  if (allIntegerPattern) return allInt64 ? 'integer' : 'string'
  if (allNumeric) return 'float'
  return 'string'
}

/** Map an inferred type to the hyparquet-writer basic type. */
export function parquetTypeFor(type: InferredType): WriterType {
  return WRITER_TYPE[type]
}

/** A single Parquet column ready for hyparquet-writer. */
export interface ParquetColumn {
  name: string
  type: WriterType
  data: CellValue[]
}

export interface BuiltColumns {
  /** Persisted resource schema (ADR-032). */
  schema: ResourceSchema
  /** Typed columns for the Parquet writer (ADR-029). */
  columnData: ParquetColumn[]
}

/**
 * Single pass over parsed CSV/TSV rows producing BOTH the persisted resource
 * schema (ADR-032) and the typed Parquet `columnData` (ADR-029). Each column's
 * values are read once and its type inferred once, so the stored schema and the
 * written data can never diverge. Column names fall back to `column_{index}`
 * for blank headers.
 */
export function buildColumns(headers: string[], dataRows: string[][]): BuiltColumns {
  const columns: ResourceColumn[] = []
  const columnData: ParquetColumn[] = []
  headers.forEach((header, colIndex) => {
    const rawValues = dataRows.map((row) => row[colIndex] ?? '')
    const inferred = inferColumnType(rawValues)
    const numeric = inferred === 'integer' || inferred === 'float'

    // Single pass over the column: convert each cell, count missing values, and
    // track numeric min/max together. A manual loop is intentional —
    // Math.min(...col) would overflow the call stack on large columns and has
    // no bigint form, and reduce/filter would allocate intermediates.
    const data: CellValue[] = new Array(rawValues.length)
    let nullCount = 0
    let min: bigint | number | undefined
    let max: bigint | number | undefined
    for (let i = 0; i < rawValues.length; i++) {
      if (rawValues[i] === '') nullCount++
      const cell = convertCell(inferred, rawValues[i])
      data[i] = cell
      if (numeric && cell !== null) {
        const n = cell as bigint | number
        if (min === undefined || n < min) min = n
        if (max === undefined || n > max) max = n
      }
    }

    // Integer bounds as decimal strings (INT64 may exceed Number's safe range).
    const stats: ColumnStats | undefined =
      min === undefined
        ? undefined
        : inferred === 'integer'
          ? { min: String(min), max: String(max) }
          : { min: min as number, max: max as number }

    const name = header || `column_${colIndex}`
    columns.push({
      name,
      type: inferred,
      nullable: nullCount > 0,
      nullCount,
      ...(stats && { stats }),
    })
    columnData.push({ name, type: parquetTypeFor(inferred), data })
  })
  return { schema: { columns, rowCount: dataRows.length }, columnData }
}

/**
 * Convert a raw CSV cell to the value expected by hyparquet-writer for the given
 * inferred type. Empty cells become null for typed columns (OPTIONAL); STRING
 * columns keep the raw string (including '').
 */
export function convertCell(type: InferredType, cell: string): CellValue {
  if (type === 'string') return cell
  if (cell === '') return null
  switch (type) {
    case 'integer':
      return BigInt(cell)
    case 'float':
      return Number(cell)
    case 'boolean':
      return cell.toLowerCase() === 'true'
  }
}
