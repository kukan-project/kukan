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
}
