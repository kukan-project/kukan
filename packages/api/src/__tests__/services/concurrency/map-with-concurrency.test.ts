import { describe, it, expect } from 'vitest'
import { mapWithConcurrency } from '../../../services/concurrency/map-with-concurrency'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('mapWithConcurrency', () => {
  it('keeps the order of the items, however they finish', async () => {
    const results = await mapWithConcurrency([30, 10, 20], 2, async (ms) => {
      await sleep(ms)
      return ms
    })
    expect(results).toEqual([30, 10, 20])
  })

  it('throws a failure only once the work in flight has ended, and starts no more', async () => {
    const started: number[] = []
    let running = 0
    const failed = mapWithConcurrency([0, 1, 2, 3], 2, async (i) => {
      started.push(i)
      running++
      try {
        if (i === 0) throw new Error('boom')
        await sleep(30)
        return i
      } finally {
        running--
      }
    })
    await expect(failed).rejects.toThrow('boom')
    // Item 1 was in flight when 0 failed: it finished before the throw
    expect(running).toBe(0)
    // Nothing started after the failure but what was already running
    expect(started).toEqual([0, 1])
  })
})
