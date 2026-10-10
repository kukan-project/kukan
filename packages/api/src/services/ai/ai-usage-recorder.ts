/**
 * KUKAN AI Usage Recorder
 * Writes what each AI call consumed to `ai_usage`
 */

import { aiUsage, type Database } from '@kukan/db'
import type { AiUsageEvent, AiUsageSink } from '@kukan/ai-adapter'
import { SUMMED_AI_USAGE_PURPOSES, usageCostUsd, type Logger } from '@kukan/shared'

/** How long summed query embeddings wait in memory before they are written */
const FLUSH_INTERVAL_MS = 15_000
/**
 * What they are summed over. A quarter hour rather than an hour: every time
 * zone's offset is a multiple of it, so a sum never straddles a local hour,
 * day or month however the site's zone is set.
 */
const BUCKET_MS = 15 * 60 * 1000

export interface AiUsageRecorder {
  sink: AiUsageSink
  /** Write what is held, and wait for writes already started */
  flush(): Promise<void>
  /** Stop the timer and flush */
  stop(): Promise<void>
}

type Row = typeof aiUsage.$inferInsert

const SUMMED = [
  'calls',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'costUsd',
  'unpricedCalls',
] as const satisfies readonly (keyof Row)[]

/**
 * Record each call as it completes, except the purposes summed instead (query
 * embeddings, SUMMED_AI_USAGE_PURPOSES), which are summed per quarter hour and
 * model and written every few seconds. Both processes call `stop` on shutdown;
 * what is held when one dies without it is lost — a flush interval of the
 * cheapest calls, against a write on every search.
 *
 * A failed write is logged and dropped; a call already made is not retried
 * for its record.
 */
export function createAiUsageRecorder(
  db: Database,
  logger: Logger,
  { flushIntervalMs = FLUSH_INTERVAL_MS }: { flushIntervalMs?: number } = {}
): AiUsageRecorder {
  const held = new Map<string, Row>()
  const writing = new Set<Promise<void>>()

  const write = (rows: Row[]) => {
    if (rows.length === 0) return
    const pending = db
      .insert(aiUsage)
      .values(rows)
      .then(() => {})
      .catch((err: unknown) =>
        logger.warn({ err, rows: rows.length }, 'AI usage could not be recorded')
      )
      .finally(() => writing.delete(pending))
    writing.add(pending)
  }

  const flush = async () => {
    const rows = [...held.values()]
    held.clear()
    write(rows)
    await Promise.all(writing)
  }

  const timer = setInterval(() => void flush(), flushIntervalMs)
  timer.unref()

  const sink: AiUsageSink = (event) => {
    const row = toRow(event)
    if (!SUMMED_AI_USAGE_PURPOSES.has(event.purpose)) {
      write([row])
      return
    }
    const bucket = new Date(Math.floor(event.at.getTime() / BUCKET_MS) * BUCKET_MS)
    const key = `${bucket.toISOString()}|${event.provider}|${event.model}`
    const sum = held.get(key)
    if (!sum) {
      held.set(key, { ...row, occurredAt: bucket })
      return
    }
    for (const field of SUMMED) sum[field] = (sum[field] ?? 0) + (row[field] ?? 0)
  }

  return {
    sink,
    flush,
    stop: async () => {
      clearInterval(timer)
      await flush()
    },
  }
}

function toRow(event: AiUsageEvent): Row {
  const cost = usageCostUsd(event.provider, event.model, event)
  return {
    occurredAt: event.at,
    provider: event.provider,
    model: event.model,
    purpose: event.purpose,
    resourceId: event.resourceId,
    calls: 1,
    inputTokens: event.inputTokens ?? 0,
    outputTokens: event.outputTokens ?? 0,
    cacheReadTokens: event.cacheReadTokens ?? 0,
    cacheWriteTokens: event.cacheWriteTokens ?? 0,
    costUsd: cost ?? 0,
    unpricedCalls: cost === null ? 1 : 0,
  }
}
