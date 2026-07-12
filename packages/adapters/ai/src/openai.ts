/**
 * KUKAN OpenAI Adapter
 * OpenAI API implementation (Phase 5)
 *
 * Primarily a connector for OpenAI-compatible endpoints (vLLM, HuggingFace TEI,
 * LM Studio, etc.) via `baseUrl`. The officially supported backends are Bedrock
 * (AWS) and Ollama (dev/on-prem) — see ADR-034.
 */

import OpenAI from 'openai'
import { AIAdapter, CompleteOptions, CompletionInfo, EmbedOptions, EmbeddingInfo } from './adapter'

export interface OpenAIConfig {
  apiKey: string
  baseUrl?: string
  embeddingModel?: string
  embeddingDimensions?: number
}

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'
const DEFAULT_EMBEDDING_DIMENSIONS = 1536
/** Only meaningful for the official API; compatible endpoints (vLLM etc.)
 *  serve their own models, so operators override the model instead. */
const DEFAULT_COMPLETION_MODEL = 'gpt-4o-mini'
const DEFAULT_COMPLETION_MAX_TOKENS = 2048

export class OpenAIAdapter implements AIAdapter {
  private client: OpenAI
  private embeddingModel: string
  private embeddingDimensions: number

  constructor(config: OpenAIConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl })
    this.embeddingModel = config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL
    this.embeddingDimensions = config.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS
  }

  async complete(prompt: string, options?: CompleteOptions): Promise<string> {
    const response = await this.client.chat.completions.create(
      {
        model: options?.model || DEFAULT_COMPLETION_MODEL,
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
    return { provider: 'openai', defaultModel: DEFAULT_COMPLETION_MODEL }
  }

  async listCompletionModels(): Promise<string[]> {
    try {
      // Fail fast like the Ollama path; the SDK otherwise waits ~10min × retries
      const response = await this.client.models.list({
        signal: AbortSignal.timeout(5000),
        maxRetries: 0,
      })
      // Keep chat-capable models; drop non-text endpoints. Works for the
      // official API (gpt*/o*) and compatible servers (their served models).
      const exclude = /embed|whisper|tts|audio|dall-e|moderation|image|realtime|transcribe/i
      return response.data
        .map((model) => model.id)
        .filter((id) => !exclude.test(id))
        .sort()
    } catch {
      return []
    }
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
