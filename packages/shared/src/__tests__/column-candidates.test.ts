import { describe, it, expect } from 'vitest'
import { columnCandidates } from '../column-candidates'
import type { ResourceColumn } from '../pipeline-types'
import type { ColumnRoleRow } from '../version-views'

const col = (name: string, type: ResourceColumn['type'], extra: Partial<ResourceColumn> = {}) =>
  ({ name, type, nullable: false, ...extra }) as ResourceColumn
const role = (name: string, r: ColumnRoleRow['role'], rule: string) =>
  ({ name, type: 'string', role: r, roleBasis: { rule } }) as ColumnRoleRow
const none = { primaryKey: null, types: null }

describe('columnCandidates', () => {
  it('offers as the key a column named as an ID, then one numbering the rows, then the leftmost', () => {
    const name = col('名称', 'string', { unique: true })
    const phone = col('電話番号', 'string', { unique: true })
    const seq = col('n', 'integer', { unique: true, stats: { min: '1', max: '10' } })
    const id = col('施設ID', 'string', { unique: true })
    // A contact's number is not an ID, nor is the "identifier" role it has for search
    expect(
      columnCandidates([name, phone], 10, [role('電話番号', 'identifier', 'phone-shape')], none)
        .primaryKey
    ).toBe('名称')
    expect(columnCandidates([name, phone, seq], 10, null, none).primaryKey).toBe('n')
    expect(columnCandidates([name, seq, id], 10, null, none).primaryKey).toBe('施設ID')
    // Not numbering every row: just the leftmost
    expect(columnCandidates([name, seq], 12, null, none).primaryKey).toBe('名称')
  })

  it('offers no key where one is set, or where no unique column can be one', () => {
    const columns = [col('n', 'integer', { unique: true }), col('f', 'float', { unique: true })]
    expect(
      columnCandidates(columns, 10, null, { primaryKey: ['n'], types: null }).primaryKey
    ).toBeNull()
    expect(columnCandidates([columns[1]], 10, null, none).primaryKey).toBeNull()
    // Settled as float, an integer column cannot carry one either
    expect(
      columnCandidates([columns[0]], 10, null, { primaryKey: null, types: { n: 'float' } })
        .primaryKey
    ).toBeNull()
  })

  it('offers text for a code of digits, and decimal for numbers written as text or read as floats', () => {
    const columns = [
      col('a', 'string'),
      col('b', 'string'),
      col('c', 'string'),
      col('d', 'string'),
      col('lat', 'float'),
      col('n', 'integer'),
    ]
    const roles = [
      role('a', 'identifier', 'leading-zero'),
      role('b', 'identifier', 'mostly-digits'),
      role('c', 'identifier', 'name-hint'),
      role('d', 'numeric-text', 'number-shape'),
    ]
    expect(columnCandidates(columns, 10, roles, none).types).toEqual({
      a: { type: 'string' },
      b: { type: 'string' },
      d: { type: 'decimal' },
      lat: { type: 'decimal' },
    })
  })

  it('offers no type for a column already settled', () => {
    expect(
      columnCandidates([col('a', 'string')], 10, [role('a', 'identifier', 'leading-zero')], {
        primaryKey: null,
        types: { a: 'integer' },
      }).types
    ).toEqual({})
  })
})
