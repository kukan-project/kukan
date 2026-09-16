import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BedrockAIAdapter } from '../bedrock'
import { AiInputRejectedError } from '../adapter'

// Mock @aws-sdk/client-bedrock-runtime
const mockSend = vi.fn()
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(function () {
    return { send: mockSend }
  }),
  InvokeModelCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input, _type: 'InvokeModel' }
  }),
  ConverseCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input, _type: 'Converse' }
  }),
  // Value imports, not types — the adapter reads them to answer what it takes
  DocumentFormat: {
    CSV: 'csv',
    DOC: 'doc',
    DOCX: 'docx',
    HTML: 'html',
    MD: 'md',
    PDF: 'pdf',
    TXT: 'txt',
    XLS: 'xls',
    XLSX: 'xlsx',
  },
  ImageFormat: { GIF: 'gif', JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
}))

function converseResponse(text: string) {
  return {
    output: { message: { content: [{ text }] } },
    stopReason: 'end_turn',
  }
}

/** The shape the SDK throws: a plain Error whose name is the API error code */
function apiError(name: string, message: string) {
  const err = new Error(message)
  err.name = name
  return err
}

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

  it('lists the built-in completion model by default', async () => {
    const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })
    expect(await adapter.listCompletionModels()).toEqual(['jp.amazon.nova-2-lite-v1:0'])
  })

  it('lists the configured completion models (the IAM-granted allow-list)', async () => {
    const adapter = new BedrockAIAdapter({
      region: 'ap-northeast-1',
      completionModels: ['us.amazon.nova-lite-v1:0', 'jp.anthropic.claude-haiku-4-5-20251001-v1:0'],
    })
    expect(await adapter.listCompletionModels()).toEqual([
      'us.amazon.nova-lite-v1:0',
      'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
    ])
  })

  describe('complete', () => {
    it('completes via Converse with the jp. Nova Lite profile by default', async () => {
      mockSend.mockResolvedValueOnce(converseResponse('こんにちは'))
      const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })

      const result = await adapter.complete('挨拶して', { system: 'あなたは司書です' })

      expect(result).toBe('こんにちは')
      const command = mockSend.mock.calls[0][0]
      expect(command._type).toBe('Converse')
      expect(command.input.modelId).toBe('jp.amazon.nova-2-lite-v1:0')
      expect(command.input.messages).toEqual([{ role: 'user', content: [{ text: '挨拶して' }] }])
      expect(command.input.system).toEqual([{ text: 'あなたは司書です' }])
      expect(command.input.inferenceConfig.maxTokens).toBe(2048)
    })

    it('respects options.model and maxTokens overrides, omitting system', async () => {
      mockSend.mockResolvedValueOnce(converseResponse('ok'))
      const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })

      await adapter.complete('x', { model: 'apac.amazon.nova-lite-v1:0', maxTokens: 500 })

      const command = mockSend.mock.calls[0][0]
      expect(command.input.modelId).toBe('apac.amazon.nova-lite-v1:0')
      expect(command.input.inferenceConfig.maxTokens).toBe(500)
      expect(command.input.system).toBeUndefined()
    })

    it('passes an abort signal when timeoutMs is given', async () => {
      mockSend.mockResolvedValueOnce(converseResponse('ok'))
      const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })

      await adapter.complete('x', { timeoutMs: 60_000 })

      const sendOptions = mockSend.mock.calls[0][1]
      expect(sendOptions.abortSignal).toBeInstanceOf(AbortSignal)
    })

    it('forces JSON via tool use when jsonSchema is set', async () => {
      mockSend.mockResolvedValueOnce({
        output: {
          message: { content: [{ toolUse: { name: 'suggest', input: { title: 'テスト' } } }] },
        },
        stopReason: 'tool_use',
      })
      const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })
      const schema = { type: 'object', properties: { title: { type: 'string' } } }

      const result = await adapter.complete('生成して', {
        jsonSchema: { name: 'suggest', schema },
      })

      expect(JSON.parse(result)).toEqual({ title: 'テスト' })
      const command = mockSend.mock.calls[0][0]
      expect(command.input.toolConfig).toEqual({
        tools: [{ toolSpec: { name: 'suggest', inputSchema: { json: schema } } }],
        toolChoice: { tool: { name: 'suggest' } },
      })
    })

    it('throws when forced JSON returns no tool use', async () => {
      mockSend.mockResolvedValueOnce(converseResponse('sorry'))
      const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })

      await expect(
        adapter.complete('x', { jsonSchema: { name: 'suggest', schema: {} } })
      ).rejects.toThrow('no tool use')
    })
  })

  it('exposes completion info as capability', () => {
    const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })
    expect(adapter.getCompletionInfo()).toEqual({
      provider: 'bedrock',
      defaultModel: 'jp.amazon.nova-2-lite-v1:0',
      allowlist: ['jp.amazon.nova-2-lite-v1:0'],
    })
  })

  describe('attachments (ADR-053)', () => {
    const pdf = {
      kind: 'document' as const,
      format: 'pdf',
      name: '令和6年 統計.pdf',
      bytes: new Uint8Array([1, 2]),
    }

    beforeEach(() => {
      mockSend.mockResolvedValue(converseResponse('ok'))
    })

    it('sends originals before the prompt, under a name the API accepts', async () => {
      const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })

      await adapter.complete('describe it', { attachments: [pdf] })

      const content = mockSend.mock.calls[0][0].input.messages[0].content
      expect(content).toHaveLength(2)
      expect(content[0].document).toMatchObject({ format: 'pdf', source: { bytes: pdf.bytes } })
      expect(content[1]).toEqual({ text: 'describe it' })
      // Whatever the resource was called, the name reaching the API is inside
      // what it accepts — the real one is quoted as data in the prompt
      expect(content[0].document.name).toMatch(/^[a-zA-Z0-9 \-()[\]]+$/)
    })

    it('sends images as image blocks', async () => {
      const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })

      await adapter.complete('describe it', {
        attachments: [{ kind: 'image', format: 'JPEG', name: 'photo', bytes: new Uint8Array([9]) }],
      })

      const content = mockSend.mock.calls[0][0].input.messages[0].content
      expect(content[0]).toEqual({
        image: { format: 'jpeg', source: { bytes: new Uint8Array([9]) } },
      })
    })

    it('refuses a format the API does not take, without spending a call', async () => {
      const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })

      await expect(
        adapter.complete('x', { attachments: [{ ...pdf, format: 'pptx' }] })
      ).rejects.toMatchObject({ name: 'AiInputRejectedError', reason: 'unsupported-format' })
      expect(mockSend).not.toHaveBeenCalled()
    })

    it('refuses an image past the API limit, without spending a call', async () => {
      const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })

      await expect(
        adapter.complete('x', {
          attachments: [
            {
              kind: 'image',
              format: 'png',
              name: 'big',
              bytes: new Uint8Array(5 * 1024 * 1024 + 1),
            },
          ],
        })
      ).rejects.toMatchObject({ name: 'AiInputRejectedError', reason: 'too-long' })
      expect(mockSend).not.toHaveBeenCalled()
    })
  })

  describe('classifying refusals', () => {
    it('reads the token count out of an over-limit refusal', async () => {
      mockSend.mockRejectedValueOnce(
        apiError('ValidationException', 'prompt is too long: 919286 tokens > 200000 maximum')
      )
      const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })

      const err = await adapter.complete('x').catch((e: unknown) => e)

      expect(err).toBeInstanceOf(AiInputRejectedError)
      expect(err).toMatchObject({ reason: 'too-long', actualTokens: 919286 })
    })

    it('treats an unsupported document format as permanent', async () => {
      mockSend.mockRejectedValueOnce(
        apiError('ValidationException', 'document.format: unsupported value')
      )
      const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })

      await expect(adapter.complete('x')).rejects.toMatchObject({ reason: 'unsupported-format' })
    })

    it('leaves a throttle alone, so the caller backs off instead of recording a verdict', async () => {
      const throttle = apiError('ThrottlingException', 'Too many requests')
      mockSend.mockRejectedValueOnce(throttle)
      const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })

      await expect(adapter.complete('x')).rejects.toBe(throttle)
    })

    it('leaves an unrecognized validation error alone — likelier our bug than the file', async () => {
      const odd = apiError('ValidationException', 'toolConfig is malformed')
      mockSend.mockRejectedValueOnce(odd)
      const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })

      await expect(adapter.complete('x')).rejects.toBe(odd)
    })
  })

  it('hands back what the completion consumed', async () => {
    // The adapter knows the numbers and nothing about what they were spent on,
    // so it reports rather than logs — a bill is only answerable with both
    mockSend.mockResolvedValueOnce({
      ...converseResponse('ok'),
      usage: { inputTokens: 2048, outputTokens: 240 },
    })
    const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })
    const seen: unknown[] = []

    await adapter.complete('x', { onUsage: (u) => seen.push(u) })

    expect(seen).toEqual([{ inputTokens: 2048, outputTokens: 240 }])
  })

  it('still reports when the provider says nothing, so a silent provider is visible', async () => {
    mockSend.mockResolvedValueOnce(converseResponse('ok'))
    const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })
    const seen: unknown[] = []

    await adapter.complete('x', { onUsage: (u) => seen.push(u) })

    expect(seen).toEqual([{ inputTokens: undefined, outputTokens: undefined }])
  })

  it('exposes what it takes as originals', () => {
    const adapter = new BedrockAIAdapter({ region: 'ap-northeast-1' })
    const info = adapter.getDocumentInfo()
    expect(info.documentFormats).toContain('pdf')
    expect(info.documentFormats).toContain('xlsx')
    expect(info.documentFormats).not.toContain('pptx')
    expect(info.imageFormats).toEqual(['gif', 'jpeg', 'png', 'webp'])
    expect(info.maxImageBytes).toBe(5 * 1024 * 1024)
  })
})
