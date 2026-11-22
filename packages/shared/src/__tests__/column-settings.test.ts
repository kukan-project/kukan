import { describe, it, expect } from 'vitest'
import { columnSettingsSchema, primaryKeyOf, readTypeOf, sameKeyColumns } from '../column-settings'
import { sameVersionIdentity } from '../version-identity'
import { sameSettledReads, type ResourceSchema } from '../pipeline-types'

describe('columnSettingsSchema', () => {
  it('refuses an empty key rather than storing a second spelling of "none"', () => {
    // "No key set" and "the key is empty" are the same state; two spellings
    // would put a branch for it in every reader (spec §6.2).
    expect(columnSettingsSchema.safeParse({ primaryKey: [] }).success).toBe(false)
    expect(columnSettingsSchema.safeParse({}).success).toBe(true)
  })

  it('takes settled types it can read, a date with its format, and refuses others', () => {
    const types = { rate: 'decimal', day: 'date:%d/%m/%Y' }
    expect(columnSettingsSchema.safeParse({ types }).success).toBe(true)
    expect(columnSettingsSchema.safeParse({ types: { rate: 'money' } }).success).toBe(false)
    expect(columnSettingsSchema.safeParse({ types: { day: 'date:%Q' } }).success).toBe(false)
  })
})

describe('primaryKeyOf', () => {
  it('answers null for every shape of "no key"', () => {
    expect(primaryKeyOf(null)).toBeNull()
    expect(primaryKeyOf(undefined)).toBeNull()
    expect(primaryKeyOf({})).toBeNull()
    // What a row can hold even though the schema refuses to write it.
    expect(primaryKeyOf({ primaryKey: [] as unknown as [string, ...string[]] })).toBeNull()
  })
})

describe('sameKeyColumns', () => {
  it('treats a reorder as a different key', () => {
    // The diff's join is written from the list, so the two describe different
    // comparisons even though they name the same columns (spec §7).
    expect(sameKeyColumns(['order', 'line'], ['line', 'order'])).toBe(false)
    expect(sameKeyColumns(['order', 'line'], ['order', 'line'])).toBe(true)
  })

  it('matches keyless against keyless only', () => {
    expect(sameKeyColumns(null, null)).toBe(true)
    expect(sameKeyColumns(null, ['id'])).toBe(false)
    expect(sameKeyColumns(['id'], null)).toBe(false)
  })
})

describe('sameVersionIdentity with a key', () => {
  const base = { hash: 'sha256:a', format: 'CSV', keyColumns: null, settledTypes: null }

  it('separates two readings that differ only in the key', () => {
    // What the version gate creates a version for, and what stops a resend
    // reporting "already at the destination" (spec §6.4).
    expect(sameVersionIdentity(base, { ...base, keyColumns: ['id'] })).toBe(false)
  })

  it('compares the key by value, not by reference', () => {
    expect(
      sameVersionIdentity({ ...base, keyColumns: ['id'] }, { ...base, keyColumns: ['id'] })
    ).toBe(true)
  })
})

describe('sameVersionIdentity with settled types', () => {
  const base = { hash: 'sha256:a', format: 'CSV', keyColumns: null, settledTypes: null }

  it('separates two readings that differ only in a settled type (spec §6.5)', () => {
    expect(sameVersionIdentity(base, { ...base, settledTypes: { rate: 'decimal' } })).toBe(false)
    expect(
      sameVersionIdentity(
        { ...base, settledTypes: { rate: 'decimal' } },
        { ...base, settledTypes: { rate: 'float' } }
      )
    ).toBe(false)
  })

  it('compares them as a record, in no order', () => {
    expect(
      sameVersionIdentity(
        { ...base, settledTypes: { a: 'string', b: 'decimal' } },
        { ...base, settledTypes: { b: 'decimal', a: 'string' } }
      )
    ).toBe(true)
  })
})

describe('sameSettledReads', () => {
  const read = (extra: object): ResourceSchema => ({
    rowCount: 1,
    columns: [{ name: 'd', type: 'date', nullable: false, nullCount: 0, ...extra }],
  })

  it('compares what each named column decided, an undecided date included', () => {
    expect(
      sameSettledReads(read({ dateFormat: '%d/%m/%Y' }), read({ dateFormat: '%d/%m/%Y' }), ['d'])
    ).toBe(true)
    expect(
      sameSettledReads(read({ dateFormat: '%d/%m/%Y' }), read({ dateFormat: '%m/%d/%Y' }), ['d'])
    ).toBe(false)
    expect(sameSettledReads(read({ dateFormatUndecided: true }), read({}), ['d'])).toBe(false)
    expect(
      sameSettledReads(
        read({ decimalPrecision: 5, decimalScale: 2 }),
        read({ decimalPrecision: 5, decimalScale: 3 }),
        ['d']
      )
    ).toBe(false)
  })

  it('takes a missing schema as one that decided nothing', () => {
    expect(sameSettledReads(null, read({}), ['d'])).toBe(true)
    expect(sameSettledReads(null, read({ dateFormat: '%d/%m/%Y' }), ['d'])).toBe(false)
  })
})

describe('readTypeOf', () => {
  const column = {
    name: 'd',
    type: 'string' as const,
    inferredType: 'string' as const,
    settled: true as const,
    dateFormatUndecided: true as const,
    nullable: false,
    nullCount: 0,
  }

  it('reads a date the live version could not order as the text it is, until a format is named', () => {
    expect(readTypeOf(column, { d: 'date' })).toBe('string')
    expect(readTypeOf(column, { d: 'date:%d/%m/%Y' })).toBe('date')
    // Settled as another type, it reads as that one
    expect(readTypeOf(column, { d: 'float' })).toBe('float')
  })

  it('reads a column by its settled type, or with none by inference', () => {
    expect(readTypeOf({ ...column, dateFormatUndecided: undefined }, { d: 'integer' })).toBe(
      'integer'
    )
    expect(readTypeOf({ ...column, type: 'integer', inferredType: 'float' }, null)).toBe('float')
  })
})
