import { describe, it, expect } from 'vitest'
import { createCache } from '../cache'

describe('createCache', () => {
  it('should create a cache with default options', () => {
    const cache = createCache()
    expect(cache).toBeDefined()
    expect(cache.max).toBe(500)
  })

  it('should create a cache with custom max', () => {
    const cache = createCache({ max: 100 })
    expect(cache.max).toBe(100)
  })

  it('should store and retrieve values', () => {
    const cache = createCache()
    cache.set('key1', 'value1')
    expect(cache.get('key1')).toBe('value1')
  })

  it('should return undefined for missing keys', () => {
    const cache = createCache()
    expect(cache.get('nonexistent')).toBeUndefined()
  })

  it('should evict oldest entries when max is exceeded', () => {
    const cache = createCache({ max: 2 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('c')).toBe(3)
  })

  it('should expire entries after TTL', async () => {
    const cache = createCache({ ttlMs: 50 })
    cache.set('key', 'value')

    expect(cache.get('key')).toBe('value')

    await new Promise((r) => setTimeout(r, 100))

    expect(cache.get('key')).toBeUndefined()
  })

  it('should not expire entries before TTL', () => {
    const cache = createCache({ ttlMs: 60_000 })
    cache.set('key', 'value')
    expect(cache.get('key')).toBe('value')
  })
})
