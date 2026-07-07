import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BedrockAIAdapter } from '../bedrock'

// Mock @aws-sdk/client-bedrock-runtime
const mockSend = vi.fn()
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(function () {
    return { send: mockSend }
  }),
  InvokeModelCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input, _type: 'InvokeModel' }
  }),
}))

function invokeResponse(embedding: number[]) {
  return { body: new TextEncoder().encode(JSON.stringify({ embedding })) }
}

/** Bedrock's Cohere v4 returns embeddings_by_type even without embedding_types (measured) */
function cohereResponse(embeddings: number[][]) {
  return {
    body: new TextEncoder().encode(
      JSON.stringify({ embeddings: { float: embeddings }, response_type: 'embeddings_by_type' })
    ),
  }
}

describe('BedrockAIAdapter', () => {
  beforeEach(() => {
    mockSend.mockReset()
  })

  it('embeds a single text via Titan v2 by default', async () => {
    mockSend.mockResolvedValueOnce(invokeResponse([0.1, 0.2]))
    const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })

    const result = await adapter.embed('こんにちは')

    expect(result).toEqual([0.1, 0.2])
    const command = mockSend.mock.calls[0][0]
    expect(command.input.modelId).toBe('amazon.titan-embed-text-v2:0')
    const body = JSON.parse(command.input.body)
    expect(body).toEqual({ inputText: 'こんにちは', dimensions: 1024, normalize: true })
  })

  it('respects embeddingModel and embeddingDimensions overrides', async () => {
    mockSend.mockResolvedValueOnce(cohereResponse([[1]]))
    const adapter = new BedrockAIAdapter({
      region: 'ap-northeast-1',
      embeddingModel: 'cohere.embed-v4:0',
      embeddingDimensions: 512,
    })

    await adapter.embed('test')

    const command = mockSend.mock.calls[0][0]
    expect(command.input.modelId).toBe('cohere.embed-v4:0')
    expect(JSON.parse(command.input.body).output_dimension).toBe(512)
    expect(adapter.getEmbeddingInfo()).toEqual({
      model: 'cohere.embed-v4:0',
      dimensions: 512,
      recommendedMinSimilarity: 0.3,
    })
  })

  it('uses the Cohere request shape with asymmetric input_type', async () => {
    mockSend.mockResolvedValue(cohereResponse([[0.5]]))
    const adapter = new BedrockAIAdapter({
      region: 'ap-northeast-1',
      embeddingModel: 'cohere.embed-v4:0',
    })

    const result = await adapter.embed('図書館はどこ?', { type: 'query' })
    await adapter.embed('市立図書館の一覧', { type: 'document' })

    expect(result).toEqual([0.5])
    const queryBody = JSON.parse(mockSend.mock.calls[0][0].input.body)
    expect(queryBody).toEqual({
      texts: ['図書館はどこ?'],
      input_type: 'search_query',
      output_dimension: 1024,
      truncate: 'RIGHT',
    })
    expect(JSON.parse(mockSend.mock.calls[1][0].input.body).input_type).toBe('search_document')
  })

  it('accepts the documented flat-array Cohere response too', async () => {
    mockSend.mockResolvedValueOnce({
      body: new TextEncoder().encode(JSON.stringify({ embeddings: [[0.7]] })),
    })
    const adapter = new BedrockAIAdapter({
      region: 'ap-northeast-1',
      embeddingModel: 'cohere.embed-v4:0',
    })

    expect(await adapter.embed('test')).toEqual([0.7])
  })

  it('embedBatch sends one Cohere call per 96 texts and preserves order', async () => {
    mockSend.mockImplementation((command: { input: { body: string } }) => {
      const { texts } = JSON.parse(command.input.body) as { texts: string[] }
      return Promise.resolve(cohereResponse(texts.map((t) => [Number(t)])))
    })
    const adapter = new BedrockAIAdapter({
      region: 'ap-northeast-1',
      embeddingModel: 'cohere.embed-v4:0',
    })

    const texts = Array.from({ length: 100 }, (_, i) => String(i))
    const results = await adapter.embedBatch(texts)

    expect(mockSend).toHaveBeenCalledTimes(2)
    expect(results).toHaveLength(100)
    results.forEach((embedding, i) => expect(embedding).toEqual([i]))
  })

  it('embedBatch preserves input order', async () => {
    mockSend.mockImplementation((command: { input: { body: string } }) => {
      const { inputText } = JSON.parse(command.input.body)
      return Promise.resolve(invokeResponse([Number(inputText)]))
    })
    const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })

    const texts = Array.from({ length: 20 }, (_, i) => String(i))
    const results = await adapter.embedBatch(texts)

    expect(results).toHaveLength(20)
    results.forEach((embedding, i) => expect(embedding).toEqual([i]))
  })

  it('exposes embedding info as capability', () => {
    const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })
    expect(adapter.getEmbeddingInfo()).toEqual({
      model: 'amazon.titan-embed-text-v2:0',
      dimensions: 1024,
      recommendedMinSimilarity: 0.15,
    })
  })
})
