import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenAIAdapter } from '../openai'

// Mock openai SDK
const mockCreate = vi.fn()
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return { embeddings: { create: mockCreate } }
  }),
}))

describe('OpenAIAdapter', () => {
  beforeEach(() => {
    mockCreate.mockReset()
  })

  it('embeds via embeddings API with text-embedding-3-small by default', async () => {
    mockCreate.mockResolvedValueOnce({ data: [{ embedding: [0.1, 0.2] }] })
    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' })

    const result = await adapter.embed('こんにちは')

    expect(result).toEqual([0.1, 0.2])
    expect(mockCreate).toHaveBeenCalledWith({
      model: 'text-embedding-3-small',
      input: ['こんにちは'],
      dimensions: 1536,
    })
  })

  it('embedBatch sends all texts in one request and preserves order', async () => {
    mockCreate.mockResolvedValueOnce({
      data: [{ embedding: [1] }, { embedding: [2] }],
    })
    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' })

    const results = await adapter.embedBatch(['a', 'b'])

    expect(results).toEqual([[1], [2]])
  })

  it('respects model and dimensions overrides', async () => {
    mockCreate.mockResolvedValueOnce({ data: [{ embedding: [1] }] })
    const adapter = new OpenAIAdapter({
      apiKey: 'sk-test',
      embeddingModel: 'text-embedding-3-large',
      embeddingDimensions: 1024,
    })

    await adapter.embed('x')

    expect(mockCreate).toHaveBeenCalledWith({
      model: 'text-embedding-3-large',
      input: ['x'],
      dimensions: 1024,
    })
    expect(adapter.getEmbeddingInfo()).toEqual({
      model: 'text-embedding-3-large',
      dimensions: 1024,
    })
  })
})
