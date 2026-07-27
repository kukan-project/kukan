import { describe, it, expect, vi } from 'vitest'
import {
  PREVIEW_PARKED_LIMIT,
  PREVIEW_RETENTION_MS,
  deletePreviews,
  dueForDeletion,
  pendingPreviewsOf,
} from '../pipeline/superseded-previews'

const NOW = 10 * 60 * 60 * 1000
const expiredAt = NOW - PREVIEW_RETENTION_MS - 1

describe('pendingPreviewsOf', () => {
  it('reads back what a previous run parked', () => {
    const entries = [{ key: 'previews/p/r.tok.parquet', at: 1 }]
    expect(pendingPreviewsOf({ supersededPreviews: entries })).toEqual(entries)
  })

  it('ignores absent or malformed metadata rather than throwing', () => {
    expect(pendingPreviewsOf(null)).toEqual([])
    expect(pendingPreviewsOf({})).toEqual([])
    expect(pendingPreviewsOf({ supersededPreviews: 'nope' })).toEqual([])
    expect(pendingPreviewsOf({ supersededPreviews: [{ key: 1 }, { at: 2 }, null] })).toEqual([])
  })
})

describe('dueForDeletion', () => {
  it('takes only what is past the retention window', () => {
    const due = dueForDeletion(
      [
        { key: 'old', at: expiredAt },
        { key: 'fresh', at: NOW - 1000 },
      ],
      NOW
    )

    expect(due).toEqual([{ key: 'old', at: expiredAt }])
  })

  it('also takes the oldest once one resource has parked too many', () => {
    // A run loop or a storage outage must not grow one JSONB row without bound.
    const fresh = Array.from({ length: PREVIEW_PARKED_LIMIT + 3 }, (_, i) => ({
      key: `k${i}`,
      at: NOW - (PREVIEW_PARKED_LIMIT + 3 - i),
    }))

    const due = dueForDeletion(fresh, NOW)

    expect(due.map((e) => e.key)).toEqual(['k0', 'k1', 'k2'])
  })

  it('takes nothing while the list is short and everything is recent', () => {
    expect(dueForDeletion([{ key: 'fresh', at: NOW - 1000 }], NOW)).toEqual([])
  })
})

describe('deletePreviews', () => {
  it('reports only the keys that are actually gone', async () => {
    const remove = vi.fn((key: string) =>
      key === 'stuck' ? Promise.reject(new Error('storage down')) : Promise.resolve()
    )

    const gone = await deletePreviews(
      [
        { key: 'ok', at: expiredAt },
        { key: 'stuck', at: expiredAt },
      ],
      remove
    )

    // 'stuck' stays parked so a later sweep retries it.
    expect(gone).toEqual(['ok'])
  })

  it('clears the whole backlog in one pass', async () => {
    // A partial pass would leave a resource parking faster than the hourly sweep
    // deletes growing without bound, so the limit above would not hold.
    const remove = vi.fn().mockResolvedValue(undefined)
    const many = Array.from({ length: 500 }, (_, i) => ({ key: `k${i}`, at: expiredAt }))

    const gone = await deletePreviews(many, remove)

    expect(gone).toHaveLength(500)
  })

  it('leaves the concurrency bound to the caller', async () => {
    // The sweep owns one limiter for the whole run; a limiter here would be
    // multiplied by the number of rows it processes at once.
    const seen: number[] = []
    let inFlight = 0
    const remove = vi.fn(async () => {
      seen.push(++inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
    })

    await deletePreviews(
      Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, at: expiredAt })),
      remove
    )

    expect(Math.max(...seen)).toBe(20)
  })
})
