import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OllamaAdapter } from '../ollama'

const mockFetch = vi.fn()

function embedResponse(embeddings: number[][]) {
  return {
    ok: true,
    json: () => Promise.resolve({ embeddings }),
  }
}

describe('OllamaAdapter', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('embeds via /api/embed with bge-m3 by default', async () => {
    mockFetch.mockResolvedValueOnce(embedResponse([[0.1, 0.2]]))
    const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' })

    const result = await adapter.embed('こんにちは')

    expect(result).toEqual([0.1, 0.2])
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embed',
      expect.objectContaining({ method: 'POST' })
    )
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body).toEqual({ model: 'bge-m3', input: ['こんにちは'] })
  })

  it('lists completion models from /api/tags, excluding embedding models', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          models: [
            { name: 'gemma4:e4b' },
            { name: 'qwen3:8b' },
            { name: 'bge-m3:latest' },
            { name: 'nomic-embed-text' },
          ],
        }),
    })
    const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' })

    const models = await adapter.listCompletionModels()

    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:11434/api/tags')
    expect(models).toEqual(['gemma4:e4b', 'qwen3:8b'])
  })

  it('returns [] when /api/tags is unavailable', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, text: () => Promise.resolve('') })
    const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' })

    expect(await adapter.listCompletionModels()).toEqual([])
  })

  it('embedBatch sends all texts in one request', async () => {
    mockFetch.mockResolvedValueOnce(
      embedResponse([
        [1, 2],
        [3, 4],
      ])
    )
    const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434/' })

    const results = await adapter.embedBatch(['a', 'b'])

    expect(results).toEqual([
      [1, 2],
      [3, 4],
    ])
    // trailing slash in baseUrl is normalized
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:11434/api/embed')
  })

  it('applies e5 prefixes only for e5-family models', async () => {
    mockFetch.mockResolvedValue(embedResponse([[1]]))
    const e5 = new OllamaAdapter({
      baseUrl: 'http://localhost:11434',
      embeddingModel: 'multilingual-e5-large',
    })

    await e5.embed('検索語', { type: 'query' })
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).input).toEqual(['query: 検索語'])

    await e5.embed('本文', { type: 'document' })
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).input).toEqual(['passage: 本文'])

    const bge = new OllamaAdapter({ baseUrl: 'http://localhost:11434' })
    await bge.embed('検索語', { type: 'query' })
    expect(JSON.parse(mockFetch.mock.calls[2][1].body).input).toEqual(['検索語'])
  })

  it('throws with status detail on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve('model not found'),
    })
    const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' })

    await expect(adapter.embed('x')).rejects.toThrow('Ollama embed failed: 404 model not found')
  })

  it('exposes embedding info as capability', () => {
    const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' })
    expect(adapter.getEmbeddingInfo()).toEqual({
      model: 'bge-m3',
      dimensions: 1024,
      recommendedMinSimilarity: 0.45,
    })
  })

  describe('complete', () => {
    function chatResponse(content: string) {
      return {
        ok: true,
        json: () => Promise.resolve({ message: { role: 'assistant', content } }),
      }
    }

    it('completes via /api/chat with gemma4:e4b by default', async () => {
      mockFetch.mockResolvedValueOnce(chatResponse('こんにちは'))
      const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' })

      const result = await adapter.complete('挨拶して', { system: 'あなたは司書です' })

      expect(result).toBe('こんにちは')
      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:11434/api/chat')
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.model).toBe('gemma4:e4b')
      expect(body.stream).toBe(false)
      expect(body.messages).toEqual([
        { role: 'system', content: 'あなたは司書です' },
        { role: 'user', content: '挨拶して' },
      ])
      expect(body.options.num_predict).toBe(2048)
      expect(body.format).toBeUndefined()
      // Reasoning is disabled so thinking models don't burn the token budget
      expect(body.think).toBe(false)
    })

    it('passes the JSON schema as structured outputs format', async () => {
      mockFetch.mockResolvedValueOnce(chatResponse('{"title":"テスト"}'))
      const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' })
      const schema = { type: 'object', properties: { title: { type: 'string' } } }

      const result = await adapter.complete('生成して', {
        jsonSchema: { name: 'suggest', schema },
        model: 'qwen3:8b',
        maxTokens: 500,
      })

      expect(JSON.parse(result)).toEqual({ title: 'テスト' })
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.format).toEqual(schema)
      expect(body.model).toBe('qwen3:8b')
      expect(body.options.num_predict).toBe(500)
    })

    it('sets an abort signal when timeoutMs is given', async () => {
      mockFetch.mockResolvedValueOnce(chatResponse('ok'))
      const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' })

      await adapter.complete('x', { timeoutMs: 120_000 })

      expect(mockFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    })

    it('throws with status detail on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('model not found'),
      })
      const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' })

      await expect(adapter.complete('x')).rejects.toThrow('Ollama chat failed: 404 model not found')
    })
  })

  it('exposes completion info as capability', () => {
    const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' })
    expect(adapter.getCompletionInfo()).toEqual({
      provider: 'ollama',
      defaultModel: 'gemma4:e4b',
    })
  })
})
