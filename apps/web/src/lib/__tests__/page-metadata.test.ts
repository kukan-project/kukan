import { describe, it, expect } from 'vitest'
import { metaDescription } from '../page-metadata'

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
