/**
 * Key and type candidates by rules (Versioning ii-c §8.6): what the Table
 * settings tab recommends, for a person to take into the draft and apply. Worked out
 * from what the screen already reads — the live schema's `unique`, and the
 * ADR-063 roles — so no API serves them.
 */
import { readTypeOf } from './column-settings'
import { canIdentifyRows, type ResourceColumn } from './pipeline-types'
import type { ColumnRoleRow } from './version-views'

export interface ColumnCandidates {
  /** A one-column key, offered only while none is set */
  primaryKey: string | null
  /** A settled type per column with none: string for a code of digits, decimal for numbers written as text */
  types: Record<string, { type: 'string' | 'decimal' }>
}

/**
 * A column named as an ID — 施設ID, 団体コード, 管理番号, No. — and not as a
 * contact's number, which changes with the place and is shared by several
 */
const ID_NAME = /(?:id|コード|ｺｰﾄﾞ|番号|no\.?|識別子)$/i
const CONTACT_NAME = /電話|郵便|fax|ファクス|ファックス|携帯|tel/i

/**
 * An integer column numbering its rows one by one, by its bounds: a 通し番号.
 * Integer bounds are decimal strings, compared as BigInts to keep every digit
 */
function numbersRows(column: ResourceColumn, rowCount: number): boolean {
  const stats = column.stats
  return (
    column.type === 'integer' &&
    typeof stats?.min === 'string' &&
    typeof stats.max === 'string' &&
    BigInt(stats.max) - BigInt(stats.min) + 1n === BigInt(rowCount)
  )
}

/** An identifier these rules found by its digits: inference may read it as an integer once its zeros go. */
const DIGIT_CODE_RULES: readonly string[] = ['leading-zero', 'mostly-digits']

export function columnCandidates(
  columns: readonly ResourceColumn[],
  rowCount: number,
  roles: readonly ColumnRoleRow[] | null,
  settings: { primaryKey: string[] | null; types: Record<string, string> | null }
): ColumnCandidates {
  const roleOf = new Map(roles?.map((row) => [row.name, row]))
  const settled = settings.types ?? {}

  let primaryKey: string | null = null
  if (!settings.primaryKey?.length) {
    const keyable = columns.filter(
      (column) => column.unique && canIdentifyRows(readTypeOf(column, settings.types))
    )
    // Named as an ID, then numbering the rows, then the leftmost: a list's
    // leftmost column is most often what each row is about. Not the ADR-063
    // "identifier" role, which is a search treatment (URLs and phone numbers
    // are in it) rather than a column that tells rows apart
    primaryKey =
      (
        keyable.find((c) => ID_NAME.test(c.name.trim()) && !CONTACT_NAME.test(c.name)) ??
        keyable.find((c) => numbersRows(c, rowCount)) ??
        keyable[0]
      )?.name ?? null
  }

  const types: ColumnCandidates['types'] = {}
  for (const column of columns) {
    if (Object.hasOwn(settled, column.name)) continue
    const row = roleOf.get(column.name)
    if (row?.role === 'identifier' && DIGIT_CODE_RULES.includes(row.roleBasis.rule)) {
      types[column.name] = { type: 'string' }
    } else if (row?.role === 'numeric-text') {
      types[column.name] = { type: 'decimal' }
    }
  }
  return { primaryKey, types }
}
