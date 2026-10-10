/**
 * Integration tests for the AI usage report: buckets cut in the site's time
 * zone, query embeddings' summed rows read like the rest, and the month's
 * straight-line projection.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { aiUsage } from '@kukan/db'
import { aiUsageReport } from '../../../services/ai/ai-usage-report'
import { createTestApp } from '../../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../../test-helpers/test-db'

const db = getTestDb()
const TOKYO = 'Asia/Tokyo'

function usage(at: string, overrides: Partial<typeof aiUsage.$inferInsert> = {}) {
  return {
    occurredAt: new Date(at),
    provider: 'bedrock' as const,
    model: 'jp.anthropic.claude-haiku-5-5',
    purpose: 'summarize' as const,
    inputTokens: 100,
    outputTokens: 10,
    costUsd: 1,
    ...overrides,
  }
}

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
})

afterAll(async () => {
  await closeTestDb()
})

describe('aiUsageReport', () => {
  it("cuts days in the site's time zone", async () => {
    await db.insert(aiUsage).values([
      // 23:30 and 00:30 in Tokyo: two days, though one UTC date
      usage('2026-10-09T14:30:00Z'),
      usage('2026-10-09T15:30:00Z'),
    ])

    const report = await aiUsageReport(db, {
      granularity: 'day',
      timeZone: TOKYO,
      now: new Date('2026-10-10T03:00:00Z'),
    })

    expect(report.buckets.map((b) => [b.start, b.calls])).toEqual([
      ['2026-10-08T15:00:00.000Z', 1],
      ['2026-10-09T15:00:00.000Z', 1],
    ])
  })

  it('sums by purpose, provider and model, and reads a summed row by its calls', async () => {
    await db.insert(aiUsage).values([
      usage('2026-10-10T01:00:00Z'),
      usage('2026-10-10T01:30:00Z'),
      usage('2026-10-10T01:00:00Z', {
        purpose: 'embed-query',
        model: 'cohere.embed-v4:0',
        calls: 40,
        inputTokens: 400,
        outputTokens: 0,
        costUsd: 0.5,
        unpricedCalls: 0,
      }),
    ])

    const report = await aiUsageReport(db, {
      granularity: 'hour',
      timeZone: TOKYO,
      now: new Date('2026-10-10T03:00:00Z'),
    })

    expect(
      report.buckets.map((b) => [b.start, b.purpose, b.calls, b.inputTokens, b.costUsd])
    ).toEqual([
      ['2026-10-10T01:00:00.000Z', 'embed-query', 40, 400, 0.5],
      ['2026-10-10T01:00:00.000Z', 'summarize', 2, 200, 2],
    ])
  })

  it('reaches back 48 hours, the month before, or 12 months', async () => {
    const now = new Date('2026-10-10T03:00:00Z')
    const from = async (granularity: 'hour' | 'day' | 'month') =>
      (await aiUsageReport(db, { granularity, timeZone: TOKYO, now })).periods[0]

    expect(await from('hour')).toBe('2026-10-08T04:00:00.000Z')
    // 1 September and 1 November 2025, both in Tokyo
    expect(await from('day')).toBe('2026-08-31T15:00:00.000Z')
    expect(await from('month')).toBe('2025-10-31T15:00:00.000Z')
  })

  it('lists every bucket in the window, the empty ones too', async () => {
    const now = new Date('2026-10-10T03:00:00Z')
    const report = (g: 'hour' | 'day' | 'month') =>
      aiUsageReport(db, { granularity: g, timeZone: TOKYO, now })

    const hours = (await report('hour')).periods
    expect(hours).toHaveLength(48)
    expect(hours.at(-1)).toBe('2026-10-10T03:00:00.000Z')
    // All of September and October up to the 10th, Tokyo
    const days = (await report('day')).periods
    expect([days.length, days[0], days.at(-1)]).toEqual([
      40,
      '2026-08-31T15:00:00.000Z',
      '2026-10-09T15:00:00.000Z',
    ])
    expect((await report('month')).periods).toHaveLength(12)
  })

  it('leaves out what falls before the window', async () => {
    await db.insert(aiUsage).values([usage('2026-08-01T00:00:00Z'), usage('2026-10-01T00:00:00Z')])

    const report = await aiUsageReport(db, {
      granularity: 'day',
      timeZone: TOKYO,
      now: new Date('2026-10-10T03:00:00Z'),
    })

    expect(report.buckets).toHaveLength(1)
  })

  it("projects the month's cost so far to its end, in a straight line", async () => {
    await db.insert(aiUsage).values([
      // September, Tokyo: not this month
      usage('2026-09-30T14:00:00Z', { costUsd: 100 }),
      usage('2026-10-01T00:00:00Z', { costUsd: 3, unpricedCalls: 1 }),
      usage('2026-10-05T00:00:00Z', { costUsd: 7 }),
    ])

    // 10 of October's 31 days gone, Tokyo
    const report = await aiUsageReport(db, {
      granularity: 'day',
      timeZone: TOKYO,
      now: new Date('2026-10-10T15:00:00Z'),
    })

    expect(report.month).toMatchObject({
      costUsd: 10,
      calls: 2,
      unpricedCalls: 1,
    })
    expect(report.month.projectedUsd).toBeCloseTo(31, 8)
  })
})

describe('aiUsageReport at the edges', () => {
  it('does not project the month before a day of it has passed', async () => {
    await db.insert(aiUsage).values([usage('2026-09-30T15:05:00Z', { costUsd: 0.5 })])

    // Ten past midnight on 1 October, Tokyo
    const report = await aiUsageReport(db, {
      granularity: 'day',
      timeZone: TOKYO,
      now: new Date('2026-09-30T15:10:00Z'),
    })

    expect(report.month.costUsd).toBe(0.5)
    expect(report.month.projectedUsd).toBeNull()
  })

  it('lists an hour the clocks skip once, not twice', async () => {
    // New York springs forward at 02:00 on 8 March 2026: 02:00 and 03:00 are one instant
    const report = await aiUsageReport(db, {
      granularity: 'hour',
      timeZone: 'America/New_York',
      now: new Date('2026-03-08T12:00:00Z'),
    })

    expect(new Set(report.periods).size).toBe(report.periods.length)
  })

  it('reaches back 48 real hours across a clock change', async () => {
    const report = await aiUsageReport(db, {
      granularity: 'hour',
      timeZone: 'America/New_York',
      now: new Date('2026-03-08T12:00:00Z'),
    })

    expect(report.periods).toHaveLength(48)
    expect(report.periods[0]).toBe('2026-03-06T13:00:00.000Z')
  })

  it('puts the two hours a clock change repeats in two buckets', async () => {
    // New York falls back at 02:00 on 1 November 2026: 01:30 comes twice
    await db.insert(aiUsage).values([usage('2026-11-01T05:30:00Z'), usage('2026-11-01T06:30:00Z')])
    const report = await aiUsageReport(db, {
      granularity: 'hour',
      timeZone: 'America/New_York',
      now: new Date('2026-11-01T12:00:00Z'),
    })

    expect(report.buckets.map((b) => b.start)).toEqual([
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T06:00:00.000Z',
    ])
    expect(report.periods).toContain('2026-11-01T05:00:00.000Z')
    expect(report.periods).toContain('2026-11-01T06:00:00.000Z')
  })

  it('cuts a day across a clock change in the zone, not in 24-hour steps', async () => {
    const report = await aiUsageReport(db, {
      granularity: 'day',
      timeZone: 'America/New_York',
      now: new Date('2026-03-10T12:00:00Z'),
    })

    // Midnight is 05:00Z before the change and 04:00Z after it
    expect(report.periods).toContain('2026-03-08T05:00:00.000Z')
    expect(report.periods).toContain('2026-03-09T04:00:00.000Z')
  })
})

describe('GET /api/v1/admin/ai-usage', () => {
  it('reports by day unless asked otherwise', async () => {
    const res = await createTestApp(db).request('/api/v1/admin/ai-usage')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { granularity: string; timeZone: string }
    expect(body).toMatchObject({ granularity: 'day', timeZone: TOKYO })
  })

  it('refuses a granularity it does not cut', async () => {
    const res = await createTestApp(db).request('/api/v1/admin/ai-usage?granularity=week')
    expect(res.status).toBe(400)
  })

  it('is for sysadmins only', async () => {
    const app = createTestApp(db, {
      user: {
        id: '00000000-0000-0000-0000-000000000002',
        email: 'u@example.com',
        name: 'u',
        sysadmin: false,
      },
    })
    expect((await app.request('/api/v1/admin/ai-usage')).status).toBe(403)
  })
})
