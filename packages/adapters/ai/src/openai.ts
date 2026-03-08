/**
 * KUKAN OpenAI Adapter
 * OpenAI API implementation (Phase 5)
 */

import { AIAdapter, CompleteOptions } from './adapter'

export interface OpenAIConfig {
  apiKey: string
  model?: string
  baseUrl?: string
}

export class OpenAIAdapter implements AIAdapter {
  constructor(_config: OpenAIConfig) {
    // Stub implementation
  }

  async complete(_prompt: string, _options?: CompleteOptions): Promise<string> {
    throw new Error('OpenAIAdapter not implemented yet (Phase 5)')
  }

  async embed(_text: string): Promise<number[]> {
    throw new Error('OpenAIAdapter not implemented yet (Phase 5)')
  }
}
