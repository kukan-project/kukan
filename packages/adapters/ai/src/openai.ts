/**
 * KUKAN OpenAI Adapter
 * OpenAI API implementation (Phase 5)
 *
 * Primarily a connector for OpenAI-compatible endpoints (vLLM, HuggingFace TEI,
 * LM Studio, etc.) via `baseUrl`. The officially supported backends are Bedrock
 * (AWS) and Ollama (dev/on-prem) — see ADR-034.
 */

import OpenAI from 'openai'
import {
  AIAdapter,
  CompleteOptions,
  CompletionInfo,
  EmbedOptions,
  EmbeddingInfo,
  resolveCompletionModels,
} from './adapter'

export interface OpenAIConfig {
  apiKey: string
  baseUrl?: string
  embeddingModel?: string
  embeddingDimensions?: number
  /** Approved models (AI_COMPLETION_MODELS): picker options + allow-list,
   *  first = default. Omit → the built-in default only */
  completionModels?: string[]
}

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'
const DEFAULT_EMBEDDING_DIMENSIONS = 1536
/** Only meaningful for the official API; compatible endpoints (vLLM etc.)
 *  serve their own models, so operators set AI_COMPLETION_MODELS instead. */
const DEFAULT_COMPLETION_MODEL = 'gpt-4o-mini'
const DEFAULT_COMPLETION_MAX_TOKENS = 2048

export class OpenAIAdapter implements AIAdapter {
  private client: OpenAI
  private embeddingModel: string
  private embeddingDimensions: number
  private completionModels: string[]
  private defaultCompletionModel: string

  constructor(config: OpenAIConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl })
    this.embeddingModel = config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL
    this.embeddingDimensions = config.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS
    this.completionModels = resolveCompletionModels(
      config.completionModels,
      DEFAULT_COMPLETION_MODEL
    )
    this.defaultCompletionModel = this.completionModels[0]
  }

  async complete(prompt: string, options?: CompleteOptions): Promise<string> {
    const response = await this.client.chat.completions.create(
      {
        model: options?.model || this.defaultCompletionModel,
        messages: [
          ...(options?.system ? [{ role: 'system' as const, content: options.system }] : []),
          { role: 'user' as const, content: prompt },
        ],
        max_tokens: options?.maxTokens ?? DEFAULT_COMPLETION_MAX_TOKENS,
        temperature: options?.temperature,
        ...(options?.jsonSchema && {
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: options.jsonSchema.name,
              schema: options.jsonSchema.schema,
              strict: true,
            },
          },
        }),
      },
      options?.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}
    )
    return response.choices[0]?.message?.content?.trim() ?? ''
  }

  getCompletionInfo(): CompletionInfo {
    return {
      provider: 'openai',
      defaultModel: this.defaultCompletionModel,
      allowlist: this.completionModels,
    }
  }

  async listCompletionModels(): Promise<string[]> {
    // The allow-list is authoritative — served does not mean approved
    return this.completionModels
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
