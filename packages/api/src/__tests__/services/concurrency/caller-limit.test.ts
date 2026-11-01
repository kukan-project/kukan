import { describe, it, expect } from 'vitest'
import { TooManyRequestsError } from '@kukan/shared'
import { CallerLimit, callerKey, ipBucket } from '../../../services/concurrency/caller-limit'

describe('CallerLimit', () => {
  it('refuses with 429 once a caller has its limit in flight', () => {
    const limit = new CallerLimit('one at a time', 7)
    limit.acquire('ip:203.0.113.5', 1)
    let refused: unknown
    try {
      limit.acquire('ip:203.0.113.5', 1)
    } catch (err) {
      refused = err
    }
    expect(refused).toBeInstanceOf(TooManyRequestsError)
    expect((refused as Error).message).toBe('one at a time')
    // The pool's own figure, carried to the response's Retry-After
    expect((refused as TooManyRequestsError).retryAfterSeconds).toBe(7)
  })

  it('admits the next request once one is released', () => {
    const limit = new CallerLimit('busy', 1)
    const release = limit.acquire('user:a', 1)
    expect(limit.held('user:a')).toBe(1)
    release()
    expect(limit.held('user:a')).toBe(0)
    expect(() => limit.acquire('user:a', 1)).not.toThrow()
  })

  it('counts each key on its own', () => {
    const limit = new CallerLimit('busy', 1)
    limit.acquire('ip:203.0.113.5', 1)
    expect(() => limit.acquire('ip:203.0.113.6', 1)).not.toThrow()
    expect(() => limit.acquire('user:a', 1)).not.toThrow()
  })

  it('applies the limit it is given per call', () => {
    const limit = new CallerLimit('busy', 1)
    limit.acquire('user:a', 2)
    limit.acquire('user:a', 2)
    expect(() => limit.acquire('user:a', 2)).toThrow(TooManyRequestsError)
  })

  it('releases once, however many times the release is called', () => {
    const limit = new CallerLimit('busy', 1)
    const release = limit.acquire('user:a', 2)
    limit.acquire('user:a', 2)
    release()
    release()
    expect(limit.held('user:a')).toBe(1)
  })
})

describe('ipBucket', () => {
  it('keeps an IPv4 address whole', () => {
    expect(ipBucket('203.0.113.5')).toBe('203.0.113.5')
  })

  it('folds an IPv6 address to its /64', () => {
    const prefix = '32.1.13.184.133.163.0.1/64'
    expect(ipBucket('2001:db8:85a3:1:8a2e:370:7334:1')).toBe(prefix)
    expect(ipBucket('2001:db8:85a3:1::2')).toBe(prefix)
    expect(ipBucket('2001:0db8:85a3:0001:0000:0000:0000:0003')).toBe(prefix)
  })

  it('folds the whole of a /64 to one bucket and no further', () => {
    expect(ipBucket('2001:db8::1')).toBe(ipBucket('2001:db8::ffff:ffff:ffff:ffff'))
    expect(ipBucket('2001:db8::1')).not.toBe(ipBucket('2001:db8:0:1::1'))
  })

  it('reads an IPv4-mapped IPv6 address as the IPv4', () => {
    expect(ipBucket('::ffff:203.0.113.5')).toBe('203.0.113.5')
    expect(ipBucket('::ffff:cb00:7105')).toBe('203.0.113.5')
  })

  it('ignores a zone id', () => {
    expect(ipBucket('fe80::1%eth0')).toBe('254.128.0.0.0.0.0.0/64')
  })

  it('handles the loopback and unspecified forms', () => {
    expect(ipBucket('::1')).toBe('0.0.0.0.0.0.0.0/64')
    expect(ipBucket('::')).toBe('0.0.0.0.0.0.0.0/64')
  })

  it('answers undefined for anything that is not an address', () => {
    expect(ipBucket('')).toBeUndefined()
    expect(ipBucket('unknown')).toBeUndefined()
    expect(ipBucket('203.0.113.5:1234')).toBeUndefined()
    expect(ipBucket('2001:db8::1::2')).toBeUndefined()
    expect(ipBucket('999.0.0.1')).toBeUndefined()
  })
})

describe('callerKey', () => {
  it('keys a signed-in caller by user, whatever the address', () => {
    expect(callerKey({ userId: 'u1', ip: '203.0.113.5' })).toBe('user:u1')
  })

  it('keys an anonymous caller by its address bucket', () => {
    expect(callerKey({ ip: '203.0.113.5' })).toBe('ip:203.0.113.5')
    expect(callerKey({ ip: '2001:db8::1' })).toBe('ip:32.1.13.184.0.0.0.0/64')
  })

  it('has no key for a caller with neither', () => {
    expect(callerKey({})).toBeUndefined()
    expect(callerKey({ ip: 'not-an-ip' })).toBeUndefined()
  })
})
