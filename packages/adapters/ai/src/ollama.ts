/**
 * KUKAN Ollama Adapter
 * Ollama local LLM implementation (Phase 5)
 */

import { AIAdapter, CompleteOptions, EmbedOptions, EmbeddingInfo } from './adapter'

export interface OllamaConfig {
  baseUrl: string
  model?: string
  embeddingModel?: string
  embeddingDimensions?: number
}

const DEFAULT_EMBEDDING_MODEL = 'bge-m3'
const DEFAULT_EMBEDDING_DIMENSIONS = 1024

export class OllamaAdapter implements AIAdapter {
  private baseUrl: string
  private embeddingModel: string
  private embeddingDimensions: number

  constructor(config: OllamaConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.embeddingModel = config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL
    this.embeddingDimensions = config.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS
  }

  async complete(_prompt: string, _options?: CompleteOptions): Promise<string> {
    throw new Error('OllamaAdapter.complete not implemented yet (Phase 5)')
  }

  async embed(text: string, options?: EmbedOptions): Promise<number[]> {
    const [embedding] = await this.embedBatch([text], options)
    return embedding
  }

  async embedBatch(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.embeddingModel,
        input: texts.map((text) => this.applyPrefix(text, options?.type)),
      }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Ollama embed failed: ${response.status} ${detail}`)
    }
    const payload = (await response.json()) as { embeddings: number[][] }
    return payload.embeddings
  }

  getEmbeddingInfo(): EmbeddingInfo {
    // bge-m3 floor measured on real data: relevant pairs 0.47-0.62, noise 0.38-0.45
    return {
      model: this.embeddingModel,
      dimensions: this.embeddingDimensions,
      recommendedMinSimilarity: this.embeddingModel.startsWith('bge-m3') ? 0.45 : undefined,
    }
  }

  /** e5-family models require asymmetric prefixes; bge-m3 and others need none */
  private applyPrefix(text: string, type?: 'query' | 'document'): string {
    if (!type || !/(^|[/-])e5\b|multilingual-e5/.test(this.embeddingModel)) return text
    return type === 'query' ? `query: ${text}` : `passage: ${text}`
  }
}
