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
  DocumentInfo,
  EmbedOptions,
  EmbeddingInfo,
  AiInputRejectedError,
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
    options?.onUsage?.({
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    })
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

  async embedBatch(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    const response = await this.client.embeddings
      .create(
        { model: this.embeddingModel, input: texts, dimensions: this.embeddingDimensions },
        options?.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}
      )
      .catch((err: unknown) => {
        throw classifyEmbedRejection(err) ?? err
      })
    return response.data.map((item) => item.embedding)
  }

  getEmbeddingInfo(): EmbeddingInfo {
    return { model: this.embeddingModel, dimensions: this.embeddingDimensions }
  }

  /** Originals are not sent to this provider in the MVP (ADR-053 §3.5) */
  getDocumentInfo(): DocumentInfo | null {
    return null
  }
}

/**
 * An input too long for the model — the one refusal about the text that will
 * happen again. OpenAI cannot truncate an embedding input, and the compatible
 * servers this adapter mostly talks to answer it their own way: OpenAI and vLLM
 * with a 400 naming the maximum context length, TEI with a 413 or 422 saying
 * the input must have fewer tokens. Any other 4xx is the request's fault or the
 * setup's, and goes up as it is.
 */
function classifyEmbedRejection(err: unknown): AiInputRejectedError | null {
  // The SDK's APIError carries the HTTP status; read it off the error rather
  // than by class, which a bundled second copy of the SDK would not match
  if (!(err instanceof Error)) return null
  const status = (err as { status?: unknown }).status
  if (typeof status !== 'number' || ![400, 413, 422].includes(status)) return null
  if (!/maximum context length|too many tokens|less than \d+ tokens|too long/i.test(err.message)) {
    return null
  }
  return new AiInputRejectedError(err.message, 'too-long')
}
