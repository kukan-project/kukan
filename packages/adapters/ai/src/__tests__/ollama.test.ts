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
    expect(adapter.getEmbeddingInfo()).toEqual({ model: 'bge-m3', dimensions: 1024 })
  })
})
