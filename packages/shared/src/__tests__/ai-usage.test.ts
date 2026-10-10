import { describe, it, expect } from 'vitest'
import { usageCostUsd } from '../ai-usage'

describe('usageCostUsd', () => {
  it('prices a Bedrock call from the rate table, profile prefix included', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(usageCostUsd('bedrock', 'jp.anthropic.claude-sonnet-4-6', usage)).toBeCloseTo(19.8, 8)
    expect(usageCostUsd('bedrock', 'global.anthropic.claude-sonnet-4-6', usage)).toBeCloseTo(18, 8)
  })

  it('leaves a Bedrock model without a rate unpriced rather than free', () => {
    expect(usageCostUsd('bedrock', 'some.model-nobody-priced', { inputTokens: 10 })).toBeNull()
  })

  it('prices a local Ollama model at nothing', () => {
    expect(usageCostUsd('ollama', 'gemma4:e4b', { inputTokens: 10, outputTokens: 10 })).toBe(0)
  })

  it('leaves OpenAI unpriced — the connector mostly talks to servers not billed per token', () => {
    expect(usageCostUsd('openai', 'gpt-4o-mini', { inputTokens: 10 })).toBeNull()
  })

  it('leaves a call whose input went unreported unpriced rather than free', () => {
    expect(usageCostUsd('bedrock', 'cohere.embed-v4:0', {})).toBeNull()
    expect(usageCostUsd('bedrock', 'cohere.embed-v4:0', { inputTokens: 1_000_000 })).toBeCloseTo(
      0.12,
      8
    )
  })
})
