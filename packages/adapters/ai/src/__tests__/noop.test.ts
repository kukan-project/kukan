import { describe, it, expect } from 'vitest'
import { NoOpAIAdapter } from '../noop'

describe('NoOpAIAdapter', () => {
  const adapter = new NoOpAIAdapter()

  describe('complete', () => {
    it('should throw (callers must gate on getCompletionInfo)', async () => {
      await expect(adapter.complete('test prompt')).rejects.toThrow(
        'AI completion is not available'
      )
    })
  })

  describe('embed', () => {
    it('should return empty array', async () => {
      const result = await adapter.embed('test text')
      expect(result).toEqual([])
    })
  })

  describe('embedBatch', () => {
    it('should return empty arrays per text', async () => {
      const result = await adapter.embedBatch(['a', 'b'])
      expect(result).toEqual([[], []])
    })
  })

  describe('getEmbeddingInfo', () => {
    it('should return null (embedding unavailable)', () => {
      expect(adapter.getEmbeddingInfo()).toBeNull()
    })
  })

  describe('getCompletionInfo', () => {
    it('should return null (completion unavailable)', () => {
      expect(adapter.getCompletionInfo()).toBeNull()
    })
  })
})
