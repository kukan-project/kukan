import { describe, it, expect } from 'vitest'
import { createSuggestRateLimiter } from '../../services/suggest/rate-limit'
import { SUGGEST_RATE_LIMIT } from '../../config'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('suggest rate limiter', () => {
  it('allows up to the limit and rejects the next request with 429', () => {
    const limiter = createSuggestRateLimiter()
    for (let i = 0; i < SUGGEST_RATE_LIMIT; i++) {
      expect(() => limiter.check('user-1')).not.toThrow()
    }
    expect(() => limiter.check('user-1')).toThrowError(expect.objectContaining({ status: 429 }))
  })

  it('tracks users independently', () => {
    const limiter = createSuggestRateLimiter(2)
    limiter.check('user-1')
    limiter.check('user-1')
    expect(() => limiter.check('user-1')).toThrow()
    expect(() => limiter.check('user-2')).not.toThrow()
  })

  it('reset() clears all counters', () => {
    const limiter = createSuggestRateLimiter(1)
    limiter.check('user-1')
    expect(() => limiter.check('user-1')).toThrow()
    limiter.reset()
    expect(() => limiter.check('user-1')).not.toThrow()
  })

  it('resets after the window expires', async () => {
    const limiter = createSuggestRateLimiter(1, 150)
    limiter.check('user-1')
    expect(() => limiter.check('user-1')).toThrow()
    await sleep(250)
    expect(() => limiter.check('user-1')).not.toThrow()
  })

  it('keeps the window anchored at the first request', async () => {
    // Generous margins — wall-clock sleeps overshoot under CI load
    const limiter = createSuggestRateLimiter(2, 600)
    limiter.check('user-1')
    await sleep(150)
    // Second request must not extend the original window
    limiter.check('user-1')
    expect(() => limiter.check('user-1')).toThrow()
    await sleep(600) // 750ms since the first request > 600ms window
    expect(() => limiter.check('user-1')).not.toThrow()
  })
})
