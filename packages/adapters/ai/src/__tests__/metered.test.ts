import { describe, it, expect, vi } from 'vitest'
import type { AIAdapter } from '../adapter'
import { meterAI, type AiUsageEvent } from '../metered'

function fakeAdapter(overrides: Partial<AIAdapter> = {}): AIAdapter {
  return {
    complete: vi.fn(async (_prompt, options) => {
      options?.onUsage?.({ inputTokens: 100, outputTokens: 20 })
      return 'ok'
    }),
    getCompletionInfo: () => ({ provider: 'bedrock', defaultModel: 'jp.default', allowlist: [] }),
    listCompletionModels: async () => [],
    embed: vi.fn(async (_text, options) => {
      options?.onUsage?.({ inputTokens: 3 })
      return [1]
    }),
    embedBatch: vi.fn(async (texts: string[], options) => {
      options?.onUsage?.({ inputTokens: 3 * texts.length })
      return texts.map(() => [1])
    }),
    getEmbeddingInfo: () => ({ model: 'cohere.embed-v4:0', dimensions: 1024 }),
    getDocumentInfo: () => null,
    ...overrides,
  }
}

describe('meterAI', () => {
  it('records a completion with its purpose, resource and the model it ran on', async () => {
    const events: AiUsageEvent[] = []
    const ai = meterAI(fakeAdapter(), (e) => events.push(e))

    await ai.complete('x', {
      model: 'jp.anthropic.claude-haiku-5-5',
      usage: { purpose: 'summarize', resourceId: 'r1' },
    })

    expect(events).toEqual([
      {
        provider: 'bedrock',
        model: 'jp.anthropic.claude-haiku-5-5',
        purpose: 'summarize',
        resourceId: 'r1',
        inputTokens: 100,
        outputTokens: 20,
        at: expect.any(Date),
      },
    ])
  })

  it("names the provider's default model when the caller named none", async () => {
    const events: AiUsageEvent[] = []
    const ai = meterAI(fakeAdapter(), (e) => events.push(e))

    await ai.complete('x', { usage: { purpose: 'connection-test' } })

    expect(events[0].model).toBe('jp.default')
  })

  it('records embeddings under the embedding model', async () => {
    const events: AiUsageEvent[] = []
    const ai = meterAI(fakeAdapter(), (e) => events.push(e))

    await ai.embedBatch(['a', 'b'], { usage: { purpose: 'embed-resource' } })
    await ai.embed('q', { type: 'query', usage: { purpose: 'embed-query' } })

    expect(events.map((e) => [e.purpose, e.model, e.inputTokens])).toEqual([
      ['embed-resource', 'cohere.embed-v4:0', 6],
      ['embed-query', 'cohere.embed-v4:0', 3],
    ])
  })

  it("still hands the usage to the caller's own callback", async () => {
    const own = vi.fn()
    const ai = meterAI(fakeAdapter(), () => {})

    await ai.complete('x', { usage: { purpose: 'suggest' }, onUsage: own })

    expect(own).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 20 })
  })

  it('does not pass the tag on to the provider', async () => {
    const inner = fakeAdapter()
    const ai = meterAI(inner, () => {})

    await ai.complete('x', { usage: { purpose: 'suggest' }, maxTokens: 5 })

    expect(vi.mocked(inner.complete).mock.calls[0][1]).not.toHaveProperty('usage')
  })

  it('records nothing for a call that failed', async () => {
    const events: AiUsageEvent[] = []
    const failing = fakeAdapter({ complete: vi.fn().mockRejectedValue(new Error('throttled')) })
    const ai = meterAI(failing, (e) => events.push(e))

    await expect(ai.complete('x', { usage: { purpose: 'summarize' } })).rejects.toThrow()

    expect(events).toEqual([])
  })

  it('does not fail a call because the recorder did', async () => {
    const ai = meterAI(fakeAdapter(), () => {
      throw new Error('recorder down')
    })

    await expect(ai.complete('x', { usage: { purpose: 'summarize' } })).resolves.toBe('ok')
  })

  it('records nothing where AI is off', async () => {
    const sink = vi.fn()
    const ai = meterAI(fakeAdapter({ getCompletionInfo: () => null }), sink)

    await ai.complete('x', { usage: { purpose: 'summarize' } })

    expect(sink).not.toHaveBeenCalled()
  })

  it('refuses a call that reaches it through the bare type without a purpose', async () => {
    const sink = vi.fn()
    const bare: AIAdapter = meterAI(fakeAdapter(), sink)

    await expect(bare.embed('x')).rejects.toThrow(/must name its purpose/)
    expect(sink).not.toHaveBeenCalled()
  })

  it('will not type-check a call that names no purpose', () => {
    const ai = meterAI(fakeAdapter(), () => {})
    // @ts-expect-error — the purpose is what makes the call countable
    void ai.complete('x', {}).catch(() => {})
    // @ts-expect-error — a bare provider adapter is not a metered one
    const bare: typeof ai = fakeAdapter()
    expect(bare).toBeDefined()
  })
})
