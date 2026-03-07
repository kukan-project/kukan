/**
 * KUKAN NoOp AI Adapter
 * Placeholder implementation for environments without AI services
 */

import { AIAdapter, CompleteOptions } from './adapter'

export class NoOpAIAdapter implements AIAdapter {
  async complete(_prompt: string, _options?: CompleteOptions): Promise<string> {
    return ''
  }

  async embed(_text: string): Promise<number[]> {
    return []
  }
}
