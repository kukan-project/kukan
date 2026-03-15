import { describe, it, expect } from 'vitest'
import { buildQuery } from '../query'

describe('buildQuery', () => {
  it('should build query string from params', () => {
    expect(buildQuery({ q: 'test' })).toBe('q=test')
  })

  it('should handle multiple params', () => {
    const result = buildQuery({ q: 'test', organization: 'org1' })
    expect(result).toContain('q=test')
    expect(result).toContain('organization=org1')
  })

  it('should omit undefined values', () => {
    expect(buildQuery({ q: 'test', tags: undefined })).toBe('q=test')
  })

  it('should omit empty string values', () => {
    expect(buildQuery({ q: 'test', tags: '' })).toBe('q=test')
  })

  it('should omit offset=0', () => {
    expect(buildQuery({ q: 'test', offset: 0 })).toBe('q=test')
  })

  it('should include non-zero offset', () => {
    const result = buildQuery({ q: 'test', offset: 20 })
    expect(result).toContain('offset=20')
  })

  it('should omit default limit=20', () => {
    expect(buildQuery({ q: 'test', limit: 20 })).toBe('q=test')
  })

  it('should include non-default limit', () => {
    const result = buildQuery({ q: 'test', limit: 50 })
    expect(result).toContain('limit=50')
  })

  it('should use custom default limit', () => {
    expect(buildQuery({ q: 'test', limit: 10 }, { limit: 10 })).toBe('q=test')
  })

  it('should return empty string for no params', () => {
    expect(buildQuery({})).toBe('')
  })
})
