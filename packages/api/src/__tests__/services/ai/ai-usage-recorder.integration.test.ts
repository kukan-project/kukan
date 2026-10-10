/**
 * Integration tests for the AI usage recorder: what reaches `ai_usage`, and
 * how query embeddings are summed into one row per hour and model.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { asc } from 'drizzle-orm'
import { aiUsage } from '@kukan/db'
import { meterAI, type AIAdapter, type AiUsageEvent } from '@kukan/ai-adapter'
import { createLogger } from '@kukan/shared'
import { createAiUsageRecorder } from '../../../services/ai/ai-usage-recorder'
import { getTestDb, cleanDatabase, closeTestDb } from '../../test-helpers/test-db'

const db = getTestDb()
const logger = createLogger({ name: 'test', level: 'silent' })

function event(overrides: Partial<AiUsageEvent> = {}): AiUsageEvent {
  return {
    provider: 'bedrock',
    model: 'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
    purpose: 'summarize',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    at: new Date('2026-10-10T03:25:00Z'),
    ...overrides,
  }
}

function rows() {
  return db.select().from(aiUsage).orderBy(asc(aiUsage.occurredAt), asc(aiUsage.purpose))
}

beforeEach(async () => {
  await cleanDatabase()
})

afterAll(async () => {
  await closeTestDb()
})

describe('createAiUsageRecorder', () => {
  it('writes a call as one row, priced at the rate of the model it ran on', async () => {
    const recorder = createAiUsageRecorder(db, logger)
    recorder.sink(event({ resourceId: '00000000-0000-0000-0000-0000000000aa' }))
    await recorder.stop()

    const [row] = await rows()
    expect(row).toMatchObject({
      provider: 'bedrock',
      purpose: 'summarize',
      resourceId: '00000000-0000-0000-0000-0000000000aa',
      calls: 1,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      unpricedCalls: 0,
    })
    // Haiku 4.5 on jp.*: 1.10 + 5.50
    expect(row.costUsd).toBeCloseTo(6.6, 8)
  })

  it('counts a call it cannot price apart, rather than as free', async () => {
    const recorder = createAiUsageRecorder(db, logger)
    recorder.sink(event({ model: 'some.model-nobody-priced' }))
    await recorder.stop()

    const [row] = await rows()
    expect(row.costUsd).toBe(0)
    expect(row.unpricedCalls).toBe(1)
  })

  it('sums query embeddings into one row per quarter hour and model', async () => {
    const recorder = createAiUsageRecorder(db, logger)
    const embedding = {
      purpose: 'embed-query' as const,
      model: 'cohere.embed-v4:0',
      outputTokens: undefined,
    }
    recorder.sink(event({ ...embedding, inputTokens: 10, at: new Date('2026-10-10T03:01:00Z') }))
    recorder.sink(event({ ...embedding, inputTokens: 20, at: new Date('2026-10-10T03:14:00Z') }))
    // The next quarter: an hour in a zone offset by a half or a quarter can start here
    recorder.sink(event({ ...embedding, inputTokens: 5, at: new Date('2026-10-10T03:15:00Z') }))
    await recorder.stop()

    const written = await rows()
    expect(
      written.map((r) => [r.occurredAt.toISOString(), r.calls, r.inputTokens, r.outputTokens])
    ).toEqual([
      ['2026-10-10T03:00:00.000Z', 2, 30, 0],
      ['2026-10-10T03:15:00.000Z', 1, 5, 0],
    ])
    expect(written[0].costUsd).toBeCloseTo((30 * 0.12) / 1e6, 12)
  })

  it('holds query embeddings until it flushes, and writes other calls at once', async () => {
    const recorder = createAiUsageRecorder(db, logger, { flushIntervalMs: 3_600_000 })
    recorder.sink(event({ purpose: 'embed-query', model: 'cohere.embed-v4:0' }))
    recorder.sink(event({ purpose: 'suggest' }))
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect((await rows()).map((r) => r.purpose)).toEqual(['suggest'])

    await recorder.stop()
    expect((await rows()).map((r) => r.purpose).sort()).toEqual(['embed-query', 'suggest'])
  })

  it('records every call made through the metered adapter', async () => {
    const recorder = createAiUsageRecorder(db, logger)
    const provider = {
      complete: async (_p: string, o?: { onUsage?: (u: object) => void }) => {
        o?.onUsage?.({ inputTokens: 7, outputTokens: 3 })
        return '{}'
      },
      embedBatch: async (texts: string[], o?: { onUsage?: (u: object) => void }) => {
        o?.onUsage?.({ inputTokens: texts.length })
        return texts.map(() => [0])
      },
      getCompletionInfo: () => ({ provider: 'bedrock', defaultModel: 'jp.x', allowlist: [] }),
      getEmbeddingInfo: () => ({ model: 'cohere.embed-v4:0', dimensions: 3 }),
    } as unknown as AIAdapter
    const ai = meterAI(provider, recorder.sink)

    await ai.complete('x', { usage: { purpose: 'connection-test' } })
    await ai.embedBatch(['a', 'b'], { usage: { purpose: 'embed-resource' } })
    await recorder.stop()

    expect((await rows()).map((r) => [r.purpose, r.model, r.inputTokens]).sort()).toEqual([
      ['connection-test', 'jp.x', 7],
      ['embed-resource', 'cohere.embed-v4:0', 2],
    ])
  })
})
