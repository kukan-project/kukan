import { describe, it, expect } from 'vitest'
import { NoOpAIAdapter } from '../noop'

describe('NoOpAIAdapter', () => {
  const adapter = new NoOpAIAdapter()

  describe('complete', () => {
    it('should return empty string', async () => {
      const result = await adapter.complete('test prompt')
      expect(result).toBe('')
    })

    it('should return empty string with options', async () => {
      const result = await adapter.complete('test', { maxTokens: 100 })
      expect(result).toBe('')
    })
  })

  describe('embed', () => {
    it('should return empty array', async () => {
      const result = await adapter.embed('test text')
      expect(result).toEqual([])
    })
  })
})
