import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenAIAdapter } from '../openai'

// Mock openai SDK
const mockCreate = vi.fn()
const mockChatCreate = vi.fn()
const mockModelsList = vi.fn()
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      embeddings: { create: mockCreate },
      chat: { completions: { create: mockChatCreate } },
      models: { list: mockModelsList },
    }
  }),
}))

describe('OpenAIAdapter', () => {
  beforeEach(() => {
    mockCreate.mockReset()
    mockChatCreate.mockReset()
    mockModelsList.mockReset()
  })

  it('lists chat models, excluding embedding/audio/image endpoints', async () => {
    mockModelsList.mockResolvedValueOnce({
      data: [
        { id: 'gpt-4o-mini' },
        { id: 'o3-mini' },
        { id: 'text-embedding-3-small' },
        { id: 'whisper-1' },
        { id: 'dall-e-3' },
      ],
    })
    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' })

    expect(await adapter.listCompletionModels()).toEqual(['gpt-4o-mini', 'o3-mini'])
  })

  it('returns [] when the models list cannot be fetched', async () => {
    mockModelsList.mockRejectedValueOnce(new Error('401'))
    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' })

    expect(await adapter.listCompletionModels()).toEqual([])
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

  describe('complete', () => {
    function chatResponse(content: string) {
      return { choices: [{ message: { role: 'assistant', content } }] }
    }

    it('completes via chat.completions with the default model', async () => {
      mockChatCreate.mockResolvedValueOnce(chatResponse('こんにちは'))
      const adapter = new OpenAIAdapter({ apiKey: 'sk-test' })

      const result = await adapter.complete('挨拶して', { system: 'あなたは司書です' })

      expect(result).toBe('こんにちは')
      const [request] = mockChatCreate.mock.calls[0]
      expect(request.model).toBe('gpt-4o-mini')
      expect(request.messages).toEqual([
        { role: 'system', content: 'あなたは司書です' },
        { role: 'user', content: '挨拶して' },
      ])
      expect(request.max_tokens).toBe(2048)
      expect(request.response_format).toBeUndefined()
    })

    it('forces JSON via json_schema response_format', async () => {
      mockChatCreate.mockResolvedValueOnce(chatResponse('{"title":"テスト"}'))
      const adapter = new OpenAIAdapter({ apiKey: 'sk-test' })
      const schema = { type: 'object', properties: { title: { type: 'string' } } }

      const result = await adapter.complete('生成して', {
        jsonSchema: { name: 'suggest', schema },
        model: 'my-vllm-model',
        maxTokens: 500,
      })

      expect(JSON.parse(result)).toEqual({ title: 'テスト' })
      const [request, options] = mockChatCreate.mock.calls[0]
      expect(request.model).toBe('my-vllm-model')
      expect(request.max_tokens).toBe(500)
      expect(request.response_format).toEqual({
        type: 'json_schema',
        json_schema: { name: 'suggest', schema, strict: true },
      })
      expect(options).toEqual({})
    })

    it('passes an abort signal when timeoutMs is given', async () => {
      mockChatCreate.mockResolvedValueOnce(chatResponse('ok'))
      const adapter = new OpenAIAdapter({ apiKey: 'sk-test' })

      await adapter.complete('x', { timeoutMs: 60_000 })

      const [, options] = mockChatCreate.mock.calls[0]
      expect(options.signal).toBeInstanceOf(AbortSignal)
    })
  })

  it('exposes completion info as capability', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' })
    expect(adapter.getCompletionInfo()).toEqual({
      provider: 'openai',
      defaultModel: 'gpt-4o-mini',
    })
  })
})
