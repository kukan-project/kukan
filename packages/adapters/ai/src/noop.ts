/**
 * KUKAN NoOp AI Adapter
 * Placeholder implementation for environments without AI services
 */

import { AIAdapter, CompleteOptions, EmbedOptions, EmbeddingInfo } from './adapter'

export class NoOpAIAdapter implements AIAdapter {
  async complete(_prompt: string, _options?: CompleteOptions): Promise<string> {
    return ''
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
