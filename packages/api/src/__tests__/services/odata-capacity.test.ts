import { describe, it, expect } from 'vitest'
import { capacity, slotsForMemory, SLOT_MB } from '../../services/odata/capacity'
import { QUERY_MAX_CONCURRENT, QUERY_MEMORY_LIMIT_MB } from '../../config'

describe('slotsForMemory', () => {
  // The scales the deployment actually ships (infra/lib/config.ts).
  it.each([
    [512, 2],
    [1024, 8],
    [2048, 8],
  ])('gives a %i MB container %i pages at once', (memoryMb, slots) => {
    expect(slotsForMemory(memoryMb)).toBe(slots)
  })

  it('leaves the query sandbox its ceiling rather than spending it twice', () => {
    // 512 MB: 256 reserved for a query, 128 for the process, 128 left = two
    // pages. Sharing the whole instead put 448 MB of DuckDB budget in a 512 MB
    // task.
    const feedBudget = slotsForMemory(512) * SLOT_MB
    expect(feedBudget + QUERY_MEMORY_LIMIT_MB * QUERY_MAX_CONCURRENT).toBeLessThanOrEqual(512 - 64)
  })

  it('never leaves a second reader waiting on the first', () => {
    expect(slotsForMemory(64)).toBe(2)
    expect(slotsForMemory(1)).toBe(2)
  })

  it('stops where more concurrency stops paying', () => {
    // Throughput against running the same pages one after another: 1.61× at
    // eight on a 7-column table, 1.24× on a 56-column one, flat from four.
    expect(slotsForMemory(64 * 1024)).toBe(8)
  })

  it('never spends what the query path reserved', () => {
    for (const mb of [512, 1024, 2048, 8192]) {
      const together = slotsForMemory(mb) * SLOT_MB + QUERY_MEMORY_LIMIT_MB * QUERY_MAX_CONCURRENT
      expect(together).toBeLessThan(mb)
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
