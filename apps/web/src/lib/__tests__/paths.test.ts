import { describe, it, expect } from 'vitest'
import { tagPath } from '../paths'

describe('tagPath', () => {
  it('should put the whole name in one segment, slashes included', () => {
    expect(tagPath('防災')).toBe('/tag/%E9%98%B2%E7%81%BD')
    expect(tagPath('a/b')).toBe('/tag/a%2Fb')
    expect(tagPath('a b?#')).toBe('/tag/a%20b%3F%23')
    expect(tagPath('v1.0')).toBe('/tag/v1.0')
  })
})
