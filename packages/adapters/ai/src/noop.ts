/**
 * KUKAN NoOp AI Adapter
 * Placeholder implementation for environments without AI services
 */

import { AIAdapter, CompleteOptions, CompletionInfo, EmbedOptions, EmbeddingInfo } from './adapter'

export class NoOpAIAdapter implements AIAdapter {
  async complete(_prompt: string, _options?: CompleteOptions): Promise<string> {
    // Fail loud: callers must gate on getCompletionInfo() before calling
    throw new Error('AI completion is not available (AI_TYPE=none)')
  }

  getCompletionInfo(): CompletionInfo | null {
    return null
  }

  async embed(_text: string, _options?: EmbedOptions): Promise<number[]> {
    return []
  }

  async embedBatch(texts: string[], _options?: EmbedOptions): Promise<number[][]> {
    return texts.map(() => [])
  }

  getEmbeddingInfo(): EmbeddingInfo | null {
    return null
  }
}
