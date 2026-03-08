/**
 * KUKAN Ollama Adapter
 * Ollama local LLM implementation (Phase 5)
 */

import { AIAdapter, CompleteOptions } from './adapter'

export interface OllamaConfig {
  baseUrl: string
  model?: string
}

export class OllamaAdapter implements AIAdapter {
  constructor(_config: OllamaConfig) {
    // Stub implementation
  }

  async complete(_prompt: string, _options?: CompleteOptions): Promise<string> {
    throw new Error('OllamaAdapter not implemented yet (Phase 5)')
  }

  async embed(_text: string): Promise<number[]> {
    throw new Error('OllamaAdapter not implemented yet (Phase 5)')
  }
}
