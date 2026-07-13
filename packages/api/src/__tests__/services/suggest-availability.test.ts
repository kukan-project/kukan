import { describe, it, expect } from 'vitest'
import type { CompletionInfo } from '@kukan/ai-adapter'
import { resolveEffectiveModel } from '../../services/suggest/availability'

describe('resolveEffectiveModel', () => {
  const bedrock: CompletionInfo = {
    provider: 'bedrock',
    defaultModel: 'm-default',
    allowlist: ['m-default', 'm-ok'],
  }

  it('uses the saved model when it is in the allow-list', () => {
    expect(resolveEffectiveModel(bedrock, 'm-ok')).toBe('m-ok')
  })

  it('falls back to the default when the saved model is outside the allow-list', () => {
    // e.g. the model was dropped from bedrock.completionModels and redeployed
    expect(resolveEffectiveModel(bedrock, 'm-removed')).toBe('m-default')
  })

  it('uses the default when nothing is saved', () => {
    expect(resolveEffectiveModel(bedrock, '')).toBe('m-default')
  })

  it('accepts any saved model when the provider has no allow-list (Ollama/OpenAI)', () => {
    const ollama: CompletionInfo = { provider: 'ollama', defaultModel: 'gemma4:e4b' }
    expect(resolveEffectiveModel(ollama, 'custom-model')).toBe('custom-model')
    expect(resolveEffectiveModel(ollama, '')).toBe('gemma4:e4b')
  })
})
