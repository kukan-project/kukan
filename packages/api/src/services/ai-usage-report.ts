/**
 * KUKAN AI Usage Report
 * Totals of `ai_usage` per hour, day or month, in the site's time zone
 */

import { and, gte, lt, sql } from 'drizzle-orm'
import { aiUsage, type Database } from '@kukan/db'
import type { AiUsageGranularity, AiUsageReport } from '@kukan/shared'

/** Where each granularity's window starts: the current `anchor`, less `back` */
const WINDOW: Record<AiUsageGranularity, { anchor: 'hour' | 'month'; back: string }> = {
  hour: { anchor: 'hour', back: '47 hours' },
  // This month and the last, so a month-end comparison is on one screen
  day: { anchor: 'month', back: '1 month' },
  month: { anchor: 'month', back: '11 months' },
}

/**
 * How much of the month must pass before it is projected. Before that, one
 * call carried over thirty days reads as a bill nobody will get — the first
 * summary of the month at ten past midnight would project in the thousands.
 */
const MIN_PROJECTION_MS = 24 * 60 * 60 * 1000

/**
 * Totals per bucket, purpose, provider and model, from the start of the window
 * to now, and this month's total with its straight-line projection.
 *
 * Buckets are cut in `timeZone`, so a day is the site's day and a month its
 * month. Only buckets with calls are returned; the screen fills the gaps.
 */
export async function aiUsageReport(
  db: Database,
  {
    granularity,
    timeZone,
    now = new Date(),
  }: { granularity: AiUsageGranularity; timeZone: string; now?: Date }
): Promise<AiUsageReport> {
  const unit = sql.raw(`'${granularity}'`)
  // The zone-aware forms (PostgreSQL 16) work on instants: an hour is a real
  // hour across a clock change, and a day or month is the zone's own
  const zone = sql`${timeZone}::text`
  const nowParam = sql`${now.toISOString()}::timestamptz`

  const { anchor, back } = WINDOW[granularity]
  const truncated = sql`date_trunc(${sql.raw(`'${anchor}'`)}, ${nowParam}, ${zone})`
  const thisMonth = sql`date_trunc('month', ${nowParam}, ${zone})`
  const { rows: boundRows } = await db.execute<{
    window_start: string
    month_start: string
    month_end: string
  }>(sql`
    SELECT date_subtract(${truncated}, ${back}::interval, ${zone}) AS window_start,
           ${thisMonth} AS month_start,
           date_add(${thisMonth}, interval '1 month', ${zone}) AS month_end
  `)
  const from = new Date(boundRows[0].window_start)
  const monthStart = new Date(boundRows[0].month_start)
  const monthEnd = new Date(boundRows[0].month_end)

  // The bucket is computed below and grouped above: a GROUP BY cannot match an
  // expression whose parameters were bound separately
  const bucketed = db
    .select({
      start: sql<Date>`date_trunc(${unit}, ${aiUsage.occurredAt}, ${zone})`.as('start'),
      purpose: aiUsage.purpose,
      provider: aiUsage.provider,
      model: aiUsage.model,
      calls: aiUsage.calls,
      inputTokens: aiUsage.inputTokens,
      outputTokens: aiUsage.outputTokens,
      cacheReadTokens: aiUsage.cacheReadTokens,
      cacheWriteTokens: aiUsage.cacheWriteTokens,
      costUsd: aiUsage.costUsd,
      unpricedCalls: aiUsage.unpricedCalls,
    })
    .from(aiUsage)
    .where(and(gte(aiUsage.occurredAt, from), lt(aiUsage.occurredAt, now)))
    .as('bucketed')

  const total = (column: unknown) => sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number)
  const periodsQuery = db.execute<{ start: string }>(sql`
    SELECT generate_series(
      ${from.toISOString()}::timestamptz,
      date_trunc(${unit}, ${nowParam}, ${zone}),
      ${`1 ${granularity}`}::interval,
      ${zone}
    ) AS start
  `)
  const rowsQuery = db
    .select({
      start: bucketed.start,
      purpose: bucketed.purpose,
      provider: bucketed.provider,
      model: bucketed.model,
      calls: total(bucketed.calls),
      inputTokens: total(bucketed.inputTokens),
      outputTokens: total(bucketed.outputTokens),
      cacheReadTokens: total(bucketed.cacheReadTokens),
      cacheWriteTokens: total(bucketed.cacheWriteTokens),
      costUsd: total(bucketed.costUsd),
      unpricedCalls: total(bucketed.unpricedCalls),
    })
    .from(bucketed)
    .groupBy(bucketed.start, bucketed.purpose, bucketed.provider, bucketed.model)
    .orderBy(bucketed.start, bucketed.purpose, bucketed.provider, bucketed.model)

  const monthQuery = db
    .select({
      costUsd: total(aiUsage.costUsd),
      calls: total(aiUsage.calls),
      unpricedCalls: total(aiUsage.unpricedCalls),
    })
    .from(aiUsage)
    .where(and(gte(aiUsage.occurredAt, monthStart), lt(aiUsage.occurredAt, now)))

  const [{ rows: periodRows }, rows, [month]] = await Promise.all([
    periodsQuery,
    rowsQuery,
    monthQuery,
  ])
  const elapsed = now.getTime() - monthStart.getTime()
  const length = monthEnd.getTime() - monthStart.getTime()
  return {
    granularity,
    timeZone,
    periods: periodRows.map((row) => new Date(row.start).toISOString()),
    buckets: rows.map((row) => ({ ...row, start: new Date(row.start).toISOString() })),
    month: {
      ...month,
      projectedUsd: elapsed >= MIN_PROJECTION_MS ? (month.costUsd * length) / elapsed : null,
    },
  }
}
