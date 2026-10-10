import { describe, it, expect } from 'vitest'
import { siteMetadataSchema, toSiteMetadataValues } from '../site-metadata'

describe('siteMetadataSchema', () => {
  it('should accept a number, a plain and a per-locale text, and a date', () => {
    const entries = [
      { key: 'population', type: 'number', value: 123456 },
      { key: 'phone', type: 'text', value: '012-345-6789' },
      { key: 'tagline', type: 'text', value: { ja: '探す', en: 'Find' } },
      { key: 'population-as-of', type: 'date', value: '2024-02-29' },
    ]
    expect(siteMetadataSchema.parse(entries)).toEqual(entries)
  })

  it.each(['2026-6-1', '2026-02-30', '2025-02-29', '2026-06-01T00:00:00Z'])(
    'should refuse %s as a date',
    (value) => {
      expect(siteMetadataSchema.safeParse([{ key: 'as-of', type: 'date', value }]).success).toBe(
        false
      )
    }
  )

  it('should refuse a number given as a string', () => {
    const result = siteMetadataSchema.safeParse([
      { key: 'population', type: 'number', value: '123,456' },
    ])
    expect(result.success).toBe(false)
  })

  it.each(['Population', '-population', 'population_total', 'a'.repeat(65), ''])(
    'should refuse the key %j',
    (key) => {
      expect(siteMetadataSchema.safeParse([{ key, type: 'number', value: 1 }]).success).toBe(false)
    }
  )

  it('should refuse a duplicate key', () => {
    const result = siteMetadataSchema.safeParse([
      { key: 'population', type: 'number', value: 1 },
      { key: 'population', type: 'number', value: 2 },
    ])
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].path).toEqual([1, 'key'])
  })

  it('should refuse a per-locale text without any language or with an unknown one', () => {
    for (const value of [{}, { fr: 'Trouver' }]) {
      expect(siteMetadataSchema.safeParse([{ key: 'tagline', type: 'text', value }]).success).toBe(
        false
      )
    }
  })

  it('should refuse text longer than the limit and more entries than the limit', () => {
    expect(
      siteMetadataSchema.safeParse([{ key: 'long', type: 'text', value: 'x'.repeat(1001) }]).success
    ).toBe(false)
    const many = Array.from({ length: 101 }, (_, i) => ({ key: `k${i}`, type: 'number', value: i }))
    expect(siteMetadataSchema.safeParse(many).success).toBe(false)
  })
})

describe('toSiteMetadataValues', () => {
  it('should key the values and drop their types', () => {
    expect(
      toSiteMetadataValues([
        { key: 'population', type: 'number', value: 123456 },
        { key: 'population-as-of', type: 'date', value: '2026-06-01' },
      ])
    ).toEqual({ population: 123456, 'population-as-of': '2026-06-01' })
  })
})
