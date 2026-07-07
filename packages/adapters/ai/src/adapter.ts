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
