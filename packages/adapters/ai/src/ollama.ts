/**
 * KUKAN Ollama Adapter
 * Ollama local LLM implementation (Phase 5)
 */

import { AIAdapter, CompleteOptions, CompletionInfo, EmbedOptions, EmbeddingInfo } from './adapter'

export interface OllamaConfig {
  baseUrl: string
  embeddingModel?: string
  embeddingDimensions?: number
}

const DEFAULT_EMBEDDING_MODEL = 'bge-m3'
const DEFAULT_EMBEDDING_DIMENSIONS = 1024
/** Multilingual and CPU-efficient effective-4B model (ADR-040) */
const DEFAULT_COMPLETION_MODEL = 'gemma4:e4b'
const DEFAULT_COMPLETION_MAX_TOKENS = 2048

export class OllamaAdapter implements AIAdapter {
  private baseUrl: string
  private embeddingModel: string
  private embeddingDimensions: number

  constructor(config: OllamaConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.embeddingModel = config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL
    this.embeddingDimensions = config.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS
  }

  async complete(prompt: string, options?: CompleteOptions): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options?.model || DEFAULT_COMPLETION_MODEL,
        messages: [
          ...(options?.system ? [{ role: 'system', content: options.system }] : []),
          { role: 'user', content: prompt },
        ],
        stream: false,
        // JSON.stringify drops undefined keys, so absent options never hit the wire
        format: options?.jsonSchema?.schema,
        // Reasoning models (qwen3 etc.) otherwise spend the token budget on
        // thinking and can truncate the JSON; non-reasoning models ignore this
        think: false,
        options: {
          num_predict: options?.maxTokens ?? DEFAULT_COMPLETION_MAX_TOKENS,
          temperature: options?.temperature,
        },
      }),
      ...(options?.timeoutMs && { signal: AbortSignal.timeout(options.timeoutMs) }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Ollama chat failed: ${response.status} ${detail}`)
    }
    const payload = (await response.json()) as { message?: { content?: string } }
    return payload.message?.content?.trim() ?? ''
  }

  getCompletionInfo(): CompletionInfo {
    return { provider: 'ollama', defaultModel: DEFAULT_COMPLETION_MODEL }
  }

  async listCompletionModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) return []
      const payload = (await response.json()) as { models?: { name: string }[] }
      // /api/tags lists all pulled models; drop the embedding ones by name
      const isEmbedding = (name: string) =>
        name === this.embeddingModel || /embed|^bge-|minilm/i.test(name)
      return (payload.models ?? []).map((m) => m.name).filter((name) => !isEmbedding(name))
    } catch {
      return []
    }
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
