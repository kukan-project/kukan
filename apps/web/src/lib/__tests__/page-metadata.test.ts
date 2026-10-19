import { describe, it, expect, vi } from 'vitest'
import { metaDescription, queryRobots } from '../page-metadata'

const brand = vi.hoisted(() => ({ brandConfig: { noindex: false } }))
vi.mock('@/brand/brand-config', () => brand)

describe('metaDescription', () => {
  it('returns undefined for empty input', () => {
    expect(metaDescription(undefined)).toBeUndefined()
    expect(metaDescription(null)).toBeUndefined()
    expect(metaDescription('   \n  ')).toBeUndefined()
  })

  it('collapses whitespace into a single line', () => {
    expect(metaDescription('  first line\n\nsecond   line  ')).toBe('first line second line')
  })

  it('truncates long text', () => {
    const result = metaDescription('あ'.repeat(300))
    expect(result).toHaveLength(200)
    expect(result?.endsWith('…')).toBe(true)
  })

  it('does not split a surrogate pair when truncating', () => {
    expect(metaDescription('👨‍👩‍👧‍👦'.repeat(300))).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  it('keeps text at the limit intact', () => {
    const text = 'あ'.repeat(200)
    expect(metaDescription(text)).toBe(text)
  })
})

describe('queryRobots', () => {
  it('leaves a page with no query to the layout, with no robots key at all', () => {
    // `robots: undefined` would clear a noindex brand's layout robots
    expect(queryRobots({})).toEqual({})
    expect('robots' in queryRobots({ q: undefined })).toBe(false)
    expect(queryRobots({ q: '' })).toEqual({})
  })

  it('keeps a query page out of the index but follows its links', () => {
    brand.brandConfig.noindex = false
    expect(queryRobots({ tags: 'x' })).toEqual({ robots: { index: false, follow: true } })
  })

  it('keeps a noindex brand at nofollow, which the page would otherwise replace', () => {
    brand.brandConfig.noindex = true
    expect(queryRobots({ q: 'x' })).toEqual({ robots: { index: false, follow: false } })
  })
})
