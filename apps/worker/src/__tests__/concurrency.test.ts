import { describe, it, expect } from 'vitest'
import { CONCURRENCY_CAP, POOL_RESERVE, jobConcurrency } from '../concurrency'

describe('jobConcurrency', () => {
  it('runs one job per connection the pool can spare, up to the cap', () => {
    expect(jobConcurrency(3)).toEqual({ concurrency: 1 })
    expect(jobConcurrency(POOL_RESERVE + CONCURRENCY_CAP + 5)).toEqual({
      concurrency: CONCURRENCY_CAP,
    })
  })

  it('runs one job however small the pool', () => {
    expect(jobConcurrency(1)).toEqual({ concurrency: 1 })
  })

  it('takes what is asked, past the cap, while the pool fits it', () => {
    expect(jobConcurrency(10, 8)).toEqual({ concurrency: 8 })
  })

  it('takes what is asked past what the pool fits, and says so', () => {
    const { concurrency, warning } = jobConcurrency(5, 4)
    expect(concurrency).toBe(4)
    expect(warning).toMatch(/needs a pool of 6.*fits 3/)
  })
})
