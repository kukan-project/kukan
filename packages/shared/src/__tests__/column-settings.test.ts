import { describe, it, expect } from 'vitest'
import { columnSettingsSchema, primaryKeyOf, sameKeyColumns } from '../column-settings'
import { sameVersionIdentity } from '../version-identity'

describe('columnSettingsSchema', () => {
  it('refuses an empty key rather than storing a second spelling of "none"', () => {
    // "No key set" and "the key is empty" are the same state; two spellings
    // would put a branch for it in every reader (spec §6.2).
    expect(columnSettingsSchema.safeParse({ primaryKey: [] }).success).toBe(false)
    expect(columnSettingsSchema.safeParse({}).success).toBe(true)
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
  const base = { hash: 'sha256:a', format: 'CSV', keyColumns: null }

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
