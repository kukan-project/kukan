/**
 * KUKAN Bedrock AI Adapter
 * AWS Bedrock implementation (Phase 5)
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  ConverseCommand,
  DocumentFormat,
  ImageFormat,
  type ContentBlock,
  type ConverseCommandInput,
  type ToolInputSchema,
} from '@aws-sdk/client-bedrock-runtime'
import { DEFAULT_BEDROCK_COMPLETION_MODEL } from '@kukan/shared/ai'
import {
  AIAdapter,
  AiInputRejectedError,
  CompleteOptions,
  CompletionAttachment,
  CompletionInfo,
  DocumentInfo,
  EmbedOptions,
  EmbeddingInfo,
  resolveCompletionModels,
} from './adapter'

export interface BedrockConfig {
  region: string
  embeddingModel?: string
  embeddingDimensions?: number
  accessKeyId?: string
  secretAccessKey?: string
  /** IAM-granted completion models, offered as the picker options. Omit → default only */
  completionModels?: string[]
}

const DEFAULT_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0'
const DEFAULT_EMBEDDING_DIMENSIONS = 1024
const DEFAULT_COMPLETION_MAX_TOKENS = 2048
/** Titan has no batch embedding API — cap concurrent InvokeModel calls instead */
const EMBED_CONCURRENCY = 8
/** Hard per-image limit the Converse API enforces, whatever the model */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** The Converse enums as plain strings, built once rather than per attachment */
const DOCUMENT_FORMATS: string[] = Object.values(DocumentFormat)
const IMAGE_FORMATS: string[] = Object.values(ImageFormat)
/** Bedrock caps the document name; ours is decorative, so it is cut short */
const MAX_DOCUMENT_NAME_CHARS = 60
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
  private completionModels: string[]
  private defaultCompletionModel: string

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
    this.completionModels = resolveCompletionModels(
      config.completionModels,
      DEFAULT_BEDROCK_COMPLETION_MODEL
    )
    // First granted entry, so the default never lands outside the IAM grants
    this.defaultCompletionModel = this.completionModels[0]
  }

  async complete(prompt: string, options?: CompleteOptions): Promise<string> {
    const input: ConverseCommandInput = {
      modelId: options?.model || this.defaultCompletionModel,
      // Originals first: the prompt reads as instructions about them, which is
      // the order Anthropic's models are trained on.
      messages: [
        { role: 'user', content: [...toContentBlocks(options?.attachments), { text: prompt }] },
      ],
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
    const response = await this.client
      .send(
        new ConverseCommand(input),
        options?.timeoutMs ? { abortSignal: AbortSignal.timeout(options.timeoutMs) } : {}
      )
      .catch((err: unknown) => {
        // A refusal of the input itself is the resource's answer, not this
        // attempt's; everything else (throttles, 5xx, timeouts) goes up as-is
        // for the caller to back off on.
        throw classifyInputRejection(err) ?? err
      })
    options?.onUsage?.({
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
    })
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
    // The allow-list = the IAM-granted models; the default is its first entry, so
    // both are always invokable
    return {
      provider: 'bedrock',
      defaultModel: this.defaultCompletionModel,
      allowlist: this.completionModels,
    }
  }

  getDocumentInfo(): DocumentInfo {
    return {
      documentFormats: DOCUMENT_FORMATS,
      imageFormats: IMAGE_FORMATS,
      maxImageBytes: MAX_IMAGE_BYTES,
    }
  }

  async listCompletionModels(): Promise<string[]> {
    // The IAM policy grants exactly these, so every option is invokable
    return this.completionModels
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

/**
 * Attachments as Converse content blocks.
 *
 * Formats are checked here rather than at the call site: what the API takes is
 * this adapter's knowledge, and a caller that guessed wrong gets the permanent
 * answer now instead of a round trip and a bill.
 */
function toContentBlocks(attachments: CompletionAttachment[] | undefined): ContentBlock[] {
  if (!attachments?.length) return []
  return attachments.map((attachment, i) => {
    const format = attachment.format.toLowerCase()
    const bytes = attachment.bytes
    if (attachment.kind === 'image') {
      if (!IMAGE_FORMATS.includes(format)) {
        throw new AiInputRejectedError(
          `Bedrock Converse does not take ${format} as an image`,
          'unsupported-format'
        )
      }
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new AiInputRejectedError(
          `Image exceeds the ${MAX_IMAGE_BYTES}-byte API limit`,
          'too-long'
        )
      }
      return { image: { format: format as ImageFormat, source: { bytes } } }
    }
    if (!DOCUMENT_FORMATS.includes(format)) {
      throw new AiInputRejectedError(
        `Bedrock Converse does not take ${format} as a document`,
        'unsupported-format'
      )
    }
    return {
      document: {
        format: format as DocumentFormat,
        name: documentName(attachment.name, i),
        source: { bytes },
      },
    }
  })
}

/**
 * A name the API will accept: alphanumerics, single spaces, hyphens,
 * parentheses and brackets only. Anything else — a Japanese filename, most of
 * ours — is dropped, and an index keeps the names distinct.
 *
 * Nothing is lost by that: the material's real name reaches the model in the
 * prompt, where it is quoted as data. AWS warns this field is read as part of
 * the context, so the neutral spelling is the safer one anyway.
 */
function documentName(raw: string, index: number): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9\s\-()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DOCUMENT_NAME_CHARS)
  return `${cleaned || 'file'} ${index + 1}`
}

/**
 * The refusals that are about the input and will happen again (ADR-053 §3.4).
 * Everything else — including a ValidationException we do not recognize, which
 * is likelier a bug in the request we build than a fact about the file —
 * returns null and is retried.
 */
function classifyInputRejection(err: unknown): AiInputRejectedError | null {
  if (err instanceof AiInputRejectedError) return err
  if (!(err instanceof Error) || err.name !== 'ValidationException') return null
  // The over-limit refusal reports what the request actually came to, so the
  // failed attempt is also the measurement (ADR-053 §3.4)
  const counted = /too long:\s*(\d+)\s*tokens/i.exec(err.message)
  if (counted) return new AiInputRejectedError(err.message, 'too-long', Number(counted[1]))
  if (/too long|too large|maximum of \d+|exceeds \d+\s*MB/i.test(err.message)) {
    return new AiInputRejectedError(err.message, 'too-long')
  }
  if (/format/i.test(err.message)) {
    return new AiInputRejectedError(err.message, 'unsupported-format')
  }
  return null
}
