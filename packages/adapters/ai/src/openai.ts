/**
 * KUKAN OpenAI Adapter
 * OpenAI API implementation (Phase 5)
 *
 * Primarily a connector for OpenAI-compatible endpoints (vLLM, HuggingFace TEI,
 * LM Studio, etc.) via `baseUrl`. The officially supported backends are Bedrock
 * (AWS) and Ollama (dev/on-prem) — see ADR-034.
 */

import OpenAI from 'openai'
import { AIAdapter, CompleteOptions, EmbedOptions, EmbeddingInfo } from './adapter'

export interface OpenAIConfig {
  apiKey: string
  model?: string
  baseUrl?: string
  embeddingModel?: string
  embeddingDimensions?: number
}

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'
const DEFAULT_EMBEDDING_DIMENSIONS = 1536

export class OpenAIAdapter implements AIAdapter {
  private client: OpenAI
  private embeddingModel: string
  private embeddingDimensions: number

  constructor(config: OpenAIConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl })
    this.embeddingModel = config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL
    this.embeddingDimensions = config.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS
  }

  async complete(_prompt: string, _options?: CompleteOptions): Promise<string> {
    throw new Error('OpenAIAdapter.complete not implemented yet (Phase 5)')
  }

  async embed(text: string, options?: EmbedOptions): Promise<number[]> {
    const [embedding] = await this.embedBatch([text], options)
    return embedding
  }

  async embedBatch(texts: string[], _options?: EmbedOptions): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.embeddingModel,
      input: texts,
      dimensions: this.embeddingDimensions,
    })
    return response.data.map((item) => item.embedding)
  }

  getEmbeddingInfo(): EmbeddingInfo {
    return { model: this.embeddingModel, dimensions: this.embeddingDimensions }
  }
}
