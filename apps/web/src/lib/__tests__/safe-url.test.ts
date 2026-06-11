import { describe, it, expect } from 'vitest'
import { safeExternalHref } from '../safe-url'

describe('safeExternalHref', () => {
  it('allows http and https URLs', () => {
    expect(safeExternalHref('http://example.com')).toBe('http://example.com')
    expect(safeExternalHref('https://example.com/path?q=1#f')).toBe(
      'https://example.com/path?q=1#f'
    )
  })

  it('allows mailto URLs', () => {
    expect(safeExternalHref('mailto:user@example.com')).toBe('mailto:user@example.com')
  })

  it('allows relative URLs (path, query, fragment, protocol-relative)', () => {
    expect(safeExternalHref('/dataset/foo')).toBe('/dataset/foo')
    expect(safeExternalHref('?q=1')).toBe('?q=1')
    expect(safeExternalHref('#section')).toBe('#section')
    expect(safeExternalHref('//example.com')).toBe('//example.com')
  })

  it('blocks javascript: scheme', () => {
    expect(safeExternalHref('javascript:alert(1)')).toBeUndefined()
    expect(safeExternalHref('JavaScript:alert(1)')).toBeUndefined()
  })

  it('blocks data: and vbscript: schemes', () => {
    expect(safeExternalHref('data:text/html,<script>alert(1)</script>')).toBeUndefined()
    expect(safeExternalHref('vbscript:msgbox(1)')).toBeUndefined()
  })

  it('blocks javascript: hidden by leading whitespace/control chars', () => {
    expect(safeExternalHref('  javascript:alert(1)')).toBeUndefined()
    expect(safeExternalHref('javascript:alert(1)')).toBeUndefined()
  })

  it('blocks javascript: with embedded tab/newline in the scheme', () => {
    expect(safeExternalHref('java\tscript:alert(1)')).toBeUndefined()
    expect(safeExternalHref('java\nscript:alert(1)')).toBeUndefined()
  })

  it('returns undefined for empty/nullish input', () => {
    expect(safeExternalHref('')).toBeUndefined()
    expect(safeExternalHref('   ')).toBeUndefined()
    expect(safeExternalHref(null)).toBeUndefined()
    expect(safeExternalHref(undefined)).toBeUndefined()
  })
})
