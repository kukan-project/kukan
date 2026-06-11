import { describe, expect, it } from 'vitest'

import { deepMerge } from '../deep-merge'

describe('deepMerge', () => {
  it('returns base unchanged when override is empty', () => {
    const base = { common: { search: '検索', login: 'ログイン' } }
    expect(deepMerge(base, {})).toEqual(base)
  })

  it('overrides top-level keys', () => {
    const base = { home: { title: 'KUKAN' } }
    const override = { home: { title: 'My Portal' } }
    expect(deepMerge(base, override)).toEqual({ home: { title: 'My Portal' } })
  })

  it('deep-merges nested objects without removing sibling keys', () => {
    const base = {
      home: { title: 'KUKAN', description: 'Data catalog' },
      common: { search: 'Search' },
    }
    const override = { home: { title: 'Custom Title' } }
    expect(deepMerge(base, override)).toEqual({
      home: { title: 'Custom Title', description: 'Data catalog' },
      common: { search: 'Search' },
    })
  })

  it('adds new keys from override', () => {
    const base = { common: { search: 'Search' } }
    const override = { custom: { greeting: 'Hello' } }
    expect(deepMerge(base, override)).toEqual({
      common: { search: 'Search' },
      custom: { greeting: 'Hello' },
    })
  })

  it('replaces arrays instead of merging them', () => {
    const base = { items: ['a', 'b'] }
    const override = { items: ['x'] }
    expect(deepMerge(base, override)).toEqual({ items: ['x'] })
  })

  it('replaces a nested object with a scalar if override is scalar', () => {
    const base = { home: { title: 'KUKAN' } }
    const override = { home: 'flat string' }
    expect(deepMerge(base, override)).toEqual({ home: 'flat string' })
  })

  it('does not mutate the base object', () => {
    const base = { home: { title: 'KUKAN', description: 'Data catalog' } }
    const baseCopy = JSON.parse(JSON.stringify(base))
    deepMerge(base, { home: { title: 'Changed' } })
    expect(base).toEqual(baseCopy)
  })

  it('handles three-level nesting', () => {
    const base = { a: { b: { c: 'original', d: 'keep' } } }
    const override = { a: { b: { c: 'changed' } } }
    expect(deepMerge(base, override)).toEqual({
      a: { b: { c: 'changed', d: 'keep' } },
    })
  })
})
