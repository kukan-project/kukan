/**
 * KUKAN Bedrock AI Adapter
 * AWS Bedrock implementation (Phase 5)
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  ConverseCommand,
  type ConverseCommandInput,
  type ToolInputSchema,
} from '@aws-sdk/client-bedrock-runtime'
import { AIAdapter, CompleteOptions, CompletionInfo, EmbedOptions, EmbeddingInfo } from './adapter'

export interface BedrockConfig {
  region: string
  embeddingModel?: string
  embeddingDimensions?: number
  accessKeyId?: string
  secretAccessKey?: string
}

const DEFAULT_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0'
const DEFAULT_EMBEDDING_DIMENSIONS = 1024
/** The jp. cross-region profile keeps inference within Tokyo/Osaka (ADR-040) */
const DEFAULT_COMPLETION_MODEL = 'jp.anthropic.claude-haiku-4-5-20251001-v1:0'
const DEFAULT_COMPLETION_MAX_TOKENS = 2048
/** Titan has no batch embedding API — cap concurrent InvokeModel calls instead */
const EMBED_CONCURRENCY = 8
/** Cohere embeds up to 96 texts per InvokeModel call */
const COHERE_BATCH_SIZE = 96
/** Golden-set-measured similarity floors (demo, 2026-07-07). Keyed on the measured
 *  model versions — an unmeasured model (e.g. cohere.embed-multilingual-v3) stays
 *  undefined so the consumer default applies. */
const MEASURED_MIN_SIMILARITY: ReadonlyArray<[prefix: string, floor: number]> = [
  ['cohere.embed-v4', 0.3],
  ['amazon.titan-embed-text-v2', 0.15],
]

export class BedrockAIAdapter implements AIAdapter {
  private client: BedrockRuntimeClient
  private embeddingModel: string
  private embeddingDimensions: number

  constructor(config: BedrockConfig) {
    this.client = new BedrockRuntimeClient({
      region: config.region,
      credentials:
        config.accessKeyId && config.secretAccessKey
          ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
          : undefined,
    })
    this.embeddingModel = config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL
    this.embeddingDimensions = config.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS
  }

  async complete(prompt: string, options?: CompleteOptions): Promise<string> {
    const input: ConverseCommandInput = {
      modelId: options?.model || DEFAULT_COMPLETION_MODEL,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: {
        maxTokens: options?.maxTokens ?? DEFAULT_COMPLETION_MAX_TOKENS,
        temperature: options?.temperature,
      },
      ...(options?.system && { system: [{ text: options.system }] }),
    }
    if (options?.jsonSchema) {
      // Forced tool use is the Converse-native way to guarantee JSON output
      input.toolConfig = {
        tools: [
          {
            toolSpec: {
              name: options.jsonSchema.name,
              // json is Smithy DocumentType, which the SDK does not re-export
              inputSchema: {
                json: options.jsonSchema.schema as ToolInputSchema.JsonMember['json'],
              },
            },
          },
        ],
        toolChoice: { tool: { name: options.jsonSchema.name } },
      }
    }
    const response = await this.client.send(
      new ConverseCommand(input),
      options?.timeoutMs ? { abortSignal: AbortSignal.timeout(options.timeoutMs) } : {}
    )
    const blocks = response.output?.message?.content ?? []
    if (options?.jsonSchema) {
      const toolUse = blocks.find((block) => block.toolUse)?.toolUse
      if (!toolUse?.input) {
        throw new Error(
          `Bedrock Converse returned no tool use for forced JSON output (stopReason: ${response.stopReason})`
        )
      }
      return JSON.stringify(toolUse.input)
    }
    return blocks
      .map((block) => block.text ?? '')
      .join('')
      .trim()
  }

  getCompletionInfo(): CompletionInfo {
    return { provider: 'bedrock', defaultModel: DEFAULT_COMPLETION_MODEL }
  }

  async listCompletionModels(): Promise<string[]> {
    // Reliable enumeration needs the control-plane ListInferenceProfiles API
    // (a separate @aws-sdk/client-bedrock client) to return region-valid,
    // invokable profile IDs like the jp./us. defaults. Until that is added,
    // return empty so the UI keeps free-text model entry for Bedrock.
    return []
  }

  private get isCohere(): boolean {
    return this.embeddingModel.startsWith('cohere.embed')
  }

  private async invokeJson<T>(body: unknown): Promise<T> {
    const response = await this.client.send(
      new InvokeModelCommand({
        modelId: this.embeddingModel,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      })
    )
    return JSON.parse(new TextDecoder().decode(response.body)) as T
  }

  /** Cohere embed request (e.g. cohere.embed-v4) — real batch API, asymmetric input_type */
  private async invokeCohere(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    const payload = await this.invokeJson<{ embeddings: number[][] | { float?: number[][] } }>({
      texts,
      input_type: options?.type === 'query' ? 'search_query' : 'search_document',
      output_dimension: this.embeddingDimensions,
      truncate: 'RIGHT',
    })
    // Bedrock returns embeddings_by_type even without embedding_types (contrary
    // to its docs, which promise a flat array) — accept both shapes and fail
    // loudly otherwise instead of an opaque destructuring TypeError in callers.
    const embeddings = Array.isArray(payload.embeddings)
      ? payload.embeddings
      : payload.embeddings?.float
    if (!embeddings) {
      throw new Error(`Unexpected Cohere embed response shape: ${Object.keys(payload).join(', ')}`)
    }
    return embeddings
  }

  async embed(text: string, options?: EmbedOptions): Promise<number[]> {
    if (this.isCohere) {
      const [embedding] = await this.invokeCohere([text], options)
      return embedding
    }
    const payload = await this.invokeJson<{ embedding: number[] }>({
      inputText: text,
      dimensions: this.embeddingDimensions,
      normalize: true,
    })
    return payload.embedding
  }

  async embedBatch(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    if (this.isCohere) {
      const results: number[][] = []
      for (let i = 0; i < texts.length; i += COHERE_BATCH_SIZE) {
        results.push(...(await this.invokeCohere(texts.slice(i, i + COHERE_BATCH_SIZE), options)))
      }
      return results
    }
    const results: number[][] = new Array(texts.length)
    for (let i = 0; i < texts.length; i += EMBED_CONCURRENCY) {
      const chunk = texts.slice(i, i + EMBED_CONCURRENCY)
      const embedded = await Promise.all(chunk.map((text) => this.embed(text, options)))
      for (let j = 0; j < embedded.length; j++) {
        results[i + j] = embedded[j]
      }
    }
    return results
  }

  getEmbeddingInfo(): EmbeddingInfo {
    return {
      model: this.embeddingModel,
      dimensions: this.embeddingDimensions,
      recommendedMinSimilarity: MEASURED_MIN_SIMILARITY.find(([prefix]) =>
        this.embeddingModel.startsWith(prefix)
      )?.[1],
    }
  }
}
