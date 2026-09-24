import { describe, it, expect } from 'vitest'
import { capacity, slotsForMemory, SLOT_MB } from '../../services/odata/capacity'
import { QUERY_MAX_CONCURRENT, QUERY_SLOT_RSS_MB } from '../../config'

describe('slotsForMemory', () => {
  // The scales the deployment actually ships (infra/lib/config.ts). 1024 MB:
  // 498 for a query slot, 128 for the process, 398 left = six pages. 512 MB has
  // nothing left and gets the floor's two regardless.
  it.each([
    [512, 2],
    [1024, 6],
    [2048, 8],
  ])('gives a %i MB container %i pages at once', (memoryMb, slots) => {
    expect(slotsForMemory(memoryMb)).toBe(slots)
  })

  it('never leaves a second reader waiting on the first', () => {
    expect(slotsForMemory(64)).toBe(2)
    expect(slotsForMemory(1)).toBe(2)
  })

  it('stops where more concurrency stops paying', () => {
    // Throughput against running the same pages one after another: flat from
    // four, before instances were kept between pages and after.
    expect(slotsForMemory(64 * 1024)).toBe(8)
  })

  it('fits the query slot, the process and the pages together, above the floor', () => {
    // The 512 MB scale sits on the floor and overcommits; see MIN_SLOTS.
    for (const mb of [1024, 2048, 8192]) {
      const together = slotsForMemory(mb) * SLOT_MB + QUERY_SLOT_RSS_MB * QUERY_MAX_CONCURRENT + 128
      expect(together).toBeLessThanOrEqual(mb)
    }
  })
})

describe('capacity', () => {
  it('reads the process memory once and lands in range', () => {
    expect(capacity.slots).toBeGreaterThanOrEqual(2)
    expect(capacity.slots).toBeLessThanOrEqual(8)
    expect(capacity.memoryMb).toBeGreaterThan(0)
    expect(['cgroup-v2', 'cgroup-v1', 'host']).toContain(capacity.source)
  })
})
