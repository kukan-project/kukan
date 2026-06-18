/**
 * KUKAN Pipeline — CSV/TSV column type inference (ADR-029)
 *
 * Conservatively infers a column's type from its string values so the Extract
 * step can write typed Parquet. A type is assigned only when EVERY non-empty
 * value matches; anything ambiguous falls back to 'string'. Pure functions —
 * no I/O — so they are straightforward to unit test.
 */

import { BOOLEAN_LITERALS } from '@/config'

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
