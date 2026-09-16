/**
 * KUKAN AI Adapter Interface
 * Pluggable AI service backend (Bedrock, OpenAI, Ollama, or NoOp)
 */

export interface AIAdapter {
  /**
   * Generate text completion from a prompt
   */
  complete(prompt: string, options?: CompleteOptions): Promise<string>

  /**
   * Completion model metadata, or null when text generation is unavailable
   * (NoOp). Callers use this as the capability flag before calling complete().
   */
  getCompletionInfo(): CompletionInfo | null

  /**
   * Candidate completion model IDs to offer in the UI (best-effort). Empty
   * when the provider can't be enumerated or generation is unavailable — the
   * caller then falls back to free-text model entry.
   */
  listCompletionModels(): Promise<string[]>

  /**
   * Generate an embedding vector for a single text
   */
  embed(text: string, options?: EmbedOptions): Promise<number[]>

  /**
   * Generate embedding vectors for multiple texts (order preserved)
   */
  embedBatch(texts: string[], options?: EmbedOptions): Promise<number[][]>

  /**
   * Embedding model metadata, or null when embedding is unavailable (NoOp).
   * Callers use this as the capability flag before calling embed().
   */
  getEmbeddingInfo(): EmbeddingInfo | null

  /**
   * Which originals this provider takes alongside a prompt, or null when it
   * takes none (ADR-053 §3.5). Callers gate options.attachments on it, so a
   * provider that cannot read a PDF is a difference in supported formats
   * rather than a missing feature — and no caller branches on provider name.
   */
  getDocumentInfo(): DocumentInfo | null
}

/**
 * An original sent with the prompt: the file itself, for content no extraction
 * gets at (ADR-053 §3.1). Adapters map `format` onto their provider's enum and
 * refuse what it does not list.
 */
export interface CompletionAttachment {
  kind: 'document' | 'image'
  /** Lower-case extension: 'pdf', 'xlsx', 'png' … */
  format: string
  /** Names the material to the model. Adapters sanitize it for the provider. */
  name: string
  bytes: Uint8Array
}

export interface DocumentInfo {
  /** Formats accepted as `kind: 'document'` */
  documentFormats: string[]
  /** Formats accepted as `kind: 'image'` */
  imageFormats: string[]
  /** Hard per-image byte limit the API enforces, whatever the model */
  maxImageBytes: number
}

/**
 * The provider refused the input itself, and will refuse it again.
 *
 * Separated from every other failure because the two are recorded differently:
 * this one is a resource's permanent answer, while a throttle or a 5xx is one
 * attempt's (ADR-053 §3.4). Mistaking the second for the first writes "we do
 * not summarize this file" over a bad minute.
 */
export class AiInputRejectedError extends Error {
  constructor(
    message: string,
    readonly reason: 'too-long' | 'unsupported-format',
    /** Tokens the request actually came to, when the refusal said so */
    readonly actualTokens?: number
  ) {
    super(message)
    this.name = 'AiInputRejectedError'
  }
}

export interface CompleteOptions {
  maxTokens?: number
  temperature?: number
  model?: string
  system?: string
  timeoutMs?: number
  /** Forces JSON output matching the schema via the provider's native
   *  mechanism. Returns a JSON string; validation is the caller's job.
   *  Write schemas within OpenAI's strict subset (all properties required,
   *  additionalProperties: false) — the OpenAI adapter enables strict mode. */
  jsonSchema?: { name: string; schema: Record<string, unknown> }
  /** Originals to send with the prompt. Gate on getDocumentInfo() first —
   *  an adapter that lists no formats throws rather than dropping them. */
  attachments?: CompletionAttachment[]
  /**
   * What the completion actually consumed, as the provider reported it.
   *
   * Handed back rather than logged here: the adapter knows the numbers and
   * nothing about what they were spent on, and a bill is only answerable with
   * both. Called once, after a successful call; a provider that reports
   * nothing calls it with an empty object rather than not at all, so a silent
   * provider is distinguishable from a silent caller.
   */
  onUsage?: (usage: CompletionUsage) => void
}

/** Tokens a completion consumed, as the provider reported them */
export interface CompletionUsage {
  inputTokens?: number
  outputTokens?: number
}

export interface CompletionInfo {
  provider: 'bedrock' | 'openai' | 'ollama'
  /** Used when the caller does not pass options.model */
  defaultModel: string
  /** Deployment-approved models (AI_COMPLETION_MODELS; on Bedrock = the IAM
   *  grants) — also the picker options. Callers reject stale saved models with it. */
  allowlist: string[]
}

/** Resolve the configured allow-list; the first entry is the default model */
export function resolveCompletionModels(
  configured: string[] | undefined,
  builtInDefault: string
): string[] {
  return configured?.length ? configured : [builtInDefault]
}

export interface EmbedOptions {
  /** Distinguishes search queries from indexed documents so adapters can
   *  apply model-specific prefixes (e.g. e5's "query:" / "passage:"). */
  type?: 'query' | 'document'
}

export interface EmbeddingInfo {
  /** Model identifier stored alongside vectors to detect mismatches (ADR-034) */
  model: string
  dimensions: number
  /**
   * Golden-set-measured cosine similarity floor for this model (Japanese pairs
   * distribute very differently per model). undefined = unmeasured; consumers
   * fall back to their own default. Overridable via SEARCH_VECTOR_MIN_SIMILARITY.
   */
  recommendedMinSimilarity?: number
}

/**
 * Identity of a vector space: the same string implies vectors are directly
 * comparable. Includes the dimension because a Matryoshka model (e.g. Titan v2)
 * can change dimensions under the same model name, and mixing dimensions in one
 * pgvector column breaks the distance operator. (ADR-034)
 */
export function embeddingKey(info: EmbeddingInfo): string {
  return `${info.model}@${info.dimensions}`
}
