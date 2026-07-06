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
    mockSend.mockResolvedValueOnce(invokeResponse([1]))
    const adapter = new BedrockAIAdapter({
      region: 'ap-northeast-1',
      embeddingModel: 'cohere.embed-multilingual-v3',
      embeddingDimensions: 512,
    })

    await adapter.embed('test')

    const command = mockSend.mock.calls[0][0]
    expect(command.input.modelId).toBe('cohere.embed-multilingual-v3')
    expect(JSON.parse(command.input.body).dimensions).toBe(512)
    expect(adapter.getEmbeddingInfo()).toEqual({
      model: 'cohere.embed-multilingual-v3',
      dimensions: 512,
    })
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
    })
  })
})
