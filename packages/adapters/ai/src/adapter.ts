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
}

export interface CompletionInfo {
  provider: 'bedrock' | 'openai' | 'ollama'
  /** Used when the caller does not pass options.model */
  defaultModel: string
  /** Authoritative model allow-list (e.g. Bedrock IAM grants). Omit when the
   *  provider accepts any model (Ollama/OpenAI free-text); callers use it to
   *  reject a stale saved model that would fail at invocation. */
  allowlist?: string[]
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
