import { describe, it, expect } from 'vitest'
import {
  inferColumnType,
  convertCell,
  parquetTypeFor,
  buildColumns,
} from '../pipeline/type-inference'

describe('inferColumnType', () => {
  it('infers integer for plain integer columns', () => {
    expect(inferColumnType(['1', '2', '3'])).toBe('integer')
    expect(inferColumnType(['0', '-1', '42'])).toBe('integer')
  })

  it('ignores empty cells when inferring', () => {
    expect(inferColumnType(['1', '', '3'])).toBe('integer')
    expect(inferColumnType(['', '1.5', ''])).toBe('float')
  })

  it('treats leading-zero numbers as strings (codes), but allows a lone "0"', () => {
    expect(inferColumnType(['01234', '05678'])).toBe('string') // postal/route codes
    expect(inferColumnType(['0', '1', '2'])).toBe('integer')
  })

  it('falls back to string for integers that overflow INT64', () => {
    expect(inferColumnType(['99999999999999999999'])).toBe('string')
    expect(inferColumnType(['9223372036854775807'])).toBe('integer') // INT64 max
    expect(inferColumnType(['9223372036854775808'])).toBe('string') // INT64 max + 1
  })

  it('keeps overflow integers as string even when mixed with decimals (no lossy float)', () => {
    // The big integer would lose digits as a DOUBLE, so the whole column stays string.
    expect(inferColumnType(['99999999999999999999', '1.5'])).toBe('string')
    expect(inferColumnType(['1', '2.5', '99999999999999999999'])).toBe('string')
    // A genuine decimal of huge magnitude is still float (DOUBLE, best-effort).
    expect(inferColumnType(['99999999999999999999.5'])).toBe('float')
  })

  it('infers float for decimals and mixed integer/decimal columns', () => {
    expect(inferColumnType(['1.5', '2.5'])).toBe('float')
    expect(inferColumnType(['1', '2.5'])).toBe('float') // integers are valid floats
    expect(inferColumnType(['0.5', '-3.25'])).toBe('float')
  })

  it('rejects leading-zero integer parts and exotic numeric notations', () => {
    expect(inferColumnType(['01.5'])).toBe('string')
    expect(inferColumnType(['1e5'])).toBe('string') // scientific
    expect(inferColumnType(['1,000'])).toBe('string') // thousands separator
    expect(inferColumnType(['1.'])).toBe('string')
    expect(inferColumnType(['.5'])).toBe('string')
  })

  it('infers boolean only for true/false (case-insensitive), not 0/1 or yes/no', () => {
    expect(inferColumnType(['true', 'false', 'TRUE'])).toBe('boolean')
    expect(inferColumnType(['0', '1'])).toBe('integer') // not boolean
    expect(inferColumnType(['yes', 'no'])).toBe('string')
  })

  it('falls back to string for mixed or non-matching columns', () => {
    expect(inferColumnType(['1', 'abc'])).toBe('string')
    expect(inferColumnType(['東京', '大阪'])).toBe('string')
    expect(inferColumnType([' 1 ', '2'])).toBe('string') // surrounding whitespace, no trim
  })

  it('returns string for all-empty or empty input', () => {
    expect(inferColumnType(['', '', ''])).toBe('string')
    expect(inferColumnType([])).toBe('string')
  })
})

describe('convertCell', () => {
  it('converts typed cells and maps empties to null', () => {
    expect(convertCell('integer', '42')).toBe(42n)
    expect(convertCell('float', '1.5')).toBe(1.5)
    expect(convertCell('boolean', 'TRUE')).toBe(true)
    expect(convertCell('boolean', 'false')).toBe(false)
    expect(convertCell('integer', '')).toBeNull()
    expect(convertCell('float', '')).toBeNull()
    expect(convertCell('boolean', '')).toBeNull()
  })

  it('keeps the raw string for string columns, including empty', () => {
    expect(convertCell('string', 'hello')).toBe('hello')
    expect(convertCell('string', '')).toBe('')
  })
})

describe('parquetTypeFor', () => {
  it('maps inferred types to hyparquet-writer basic types', () => {
    expect(parquetTypeFor('integer')).toBe('INT64')
    expect(parquetTypeFor('float')).toBe('DOUBLE')
    expect(parquetTypeFor('boolean')).toBe('BOOLEAN')
    expect(parquetTypeFor('string')).toBe('STRING')
  })
})

describe('buildColumns — schema (ADR-032)', () => {
  it('infers column types, counts missing cells, and records the row count', () => {
    const { schema } = buildColumns(
      ['id', 'price', 'flag', 'name'],
      [
        ['1', '1.5', 'true', 'Alice'],
        ['2', '', 'false', 'Bob'],
        ['3', '3.25', 'true', ''],
      ]
    )

    expect(schema.rowCount).toBe(3)
    expect(schema.columns).toEqual([
      { name: 'id', type: 'integer', nullable: false, nullCount: 0, stats: { min: '1', max: '3' } },
      {
        name: 'price',
        type: 'float',
        nullable: true,
        nullCount: 1,
        stats: { min: 1.5, max: 3.25 },
      },
      { name: 'flag', type: 'boolean', nullable: false, nullCount: 0 },
      { name: 'name', type: 'string', nullable: true, nullCount: 1 },
    ])
  })

  it('computes numeric min/max stats (integer as string, float as number) and omits non-numeric', () => {
    const { schema } = buildColumns(
      ['n', 'f', 's'],
      [
        ['-5', '2.5', 'x'],
        ['10', '', 'y'],
        ['3', '-1.0', 'z'],
      ]
    )
    const byName = Object.fromEntries(schema.columns.map((c) => [c.name, c]))
    expect(byName.n.stats).toEqual({ min: '-5', max: '10' })
    expect(byName.f.stats).toEqual({ min: -1, max: 2.5 })
    expect(byName.s.stats).toBeUndefined()
  })

  it('omits stats for a numeric column with no non-null values', () => {
    const { schema } = buildColumns(['empty'], [[''], ['']])
    // all-empty → inferred as string, so no stats regardless
    expect(schema.columns[0].stats).toBeUndefined()
  })

  it('derives Parquet columnData from the same pass as the schema', () => {
    const { columnData } = buildColumns(
      ['id', 'price'],
      [
        ['1', '1.5'],
        ['2', ''],
      ]
    )
    expect(columnData).toEqual([
      { name: 'id', type: 'INT64', data: [1n, 2n] },
      { name: 'price', type: 'DOUBLE', data: [1.5, null] },
    ])
  })

  it('falls back to column_{index} for blank headers', () => {
    const { schema } = buildColumns(['', 'b'], [['x', 'y']])
    expect(schema.columns.map((c) => c.name)).toEqual(['column_0', 'b'])
  })

  it('treats missing trailing cells as empty (null) values', () => {
    // Second row is short — the missing cell counts as a missing value.
    const { schema } = buildColumns(['a', 'b'], [['1', '2'], ['3']])
    const b = schema.columns.find((c) => c.name === 'b')!
    expect(b.nullCount).toBe(1)
    expect(b.nullable).toBe(true)
  })
})
