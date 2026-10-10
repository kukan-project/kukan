import { describe, it, expect } from 'vitest'
import { createSiteMetadata, formatSiteDate, formatSiteNumber } from '../site-metadata'

const metadata = createSiteMetadata({
  population: 123456,
  'population-as-of': '2026-06-01',
  phone: '012-345-6789',
  tagline: { ja: '探す・見る', en: 'Find and view' },
  // A text entry whose string looks like a date but is not one
  'not-a-date': '2026-02-30',
  'tagline-ja-only': { ja: '探す' },
})

describe('createSiteMetadata', () => {
  it('should read each value only as its own type', () => {
    expect(metadata.number('population')).toBe(123456)
    expect(metadata.number('phone')).toBeUndefined()
    expect(metadata.date('population-as-of')).toBe('2026-06-01')
    expect(metadata.date('phone')).toBeUndefined()
    expect(metadata.date('not-a-date')).toBeUndefined()
    expect(metadata.text('population', 'ja')).toBeUndefined()
  })

  it('should resolve a per-locale text, falling back like the brand texts', () => {
    expect(metadata.text('tagline', 'ja')).toBe('探す・見る')
    expect(metadata.text('tagline', 'en')).toBe('Find and view')
    expect(metadata.text('tagline-ja-only', 'en')).toBe('探す')
    expect(metadata.text('phone', 'en')).toBe('012-345-6789')
  })

  it('should read a missing key, or a missing settings response, as undefined', () => {
    expect(metadata.number('households')).toBeUndefined()
    expect(createSiteMetadata().text('tagline', 'ja')).toBeUndefined()
    // Not the prototype's
    expect(metadata.text('toString', 'ja')).toBeUndefined()
  })
})

describe('formatSiteNumber', () => {
  it('should group digits for the locale', () => {
    expect(formatSiteNumber(123456, 'ja')).toBe('123,456')
    expect(formatSiteNumber(123456.5, 'en', { fractionDigits: 0 })).toBe('123,457')
  })

  it("should keep the value's own decimals when none are fixed", () => {
    expect(formatSiteNumber(0.0001, 'ja')).toBe('0.0001')
    expect(formatSiteNumber(1.5, 'ja', { fractionDigits: 2 })).toBe('1.50')
  })

  it('should sign a change on request, but not a zero', () => {
    expect(formatSiteNumber(12, 'ja', { signed: true })).toBe('+12')
    expect(formatSiteNumber(-12, 'ja', { signed: true })).toBe('-12')
    expect(formatSiteNumber(0, 'ja', { signed: true })).toBe('0')
  })
})

describe('formatSiteDate', () => {
  it('should use the Japanese era on a Japanese page and the Gregorian calendar otherwise', () => {
    expect(formatSiteDate('2026-06-01', 'ja')).toBe('令和8年6月1日')
    expect(formatSiteDate('2019-05-01', 'ja')).toBe('令和元年5月1日')
    expect(formatSiteDate('2026-06-01', 'en')).toBe('June 1, 2026')
  })

  it('should follow an explicit calendar', () => {
    expect(formatSiteDate('2026-06-01', 'ja', 'gregory')).toBe('2026年6月1日')
  })

  it('should keep the day whatever the host zone', () => {
    // A calendar date parsed as UTC midnight is the previous day west of UTC
    expect(formatSiteDate('2026-01-01', 'en')).toBe('January 1, 2026')
  })
})
