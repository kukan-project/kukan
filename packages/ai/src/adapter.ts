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
   * Generate embeddings for text
   */
  embed(text: string): Promise<number[]>
}

export interface CompleteOptions {
  maxTokens?: number
  temperature?: number
  model?: string
}
