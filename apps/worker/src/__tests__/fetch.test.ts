import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'crypto'
import { Readable } from 'stream'
import { executeFetch } from '../pipeline/steps/fetch'
import type { PipelineContext, ResourceForPipeline } from '../pipeline/types'

// Mock safeFetch to use globalThis.fetch directly (SSRF logic tested separately)
vi.mock('@/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => globalThis.fetch(...(args as Parameters<typeof fetch>)),
}))

function makeResource(overrides: Partial<ResourceForPipeline>): ResourceForPipeline {
  return {
    id: 'res-1',
    packageId: 'pkg-1',
    name: null,
    description: null,
    url: null,
    urlType: null,
    format: 'CSV',
    hash: null,
    ...overrides,
  }
}

/** Collect all data from a stream into a Buffer */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** Create mock context with storage.upload that consumes the stream */
function createMockCtx(overrides?: Partial<PipelineContext>): PipelineContext {
  return {
    storage: {
      download: vi.fn(),
      upload: vi.fn(async (_key: string, body: Buffer | Readable) => {
        if (body instanceof Readable) {
          await streamToBuffer(body)
        }
      }),
    },
    getResource: vi.fn(),
    updateResourceHashAndSize: vi.fn(),
    acquireFetchSlot: vi.fn().mockResolvedValue(true),
    indexContent: vi.fn(),
    deleteContent: vi.fn(),
    updatePipelineMetadata: vi.fn(),
    ...overrides,
  }
}

describe('executeFetch', () => {
  it('should throw NotFoundError when resource not found', async () => {
    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue(null)

    await expect(executeFetch('nonexistent', ctx)).rejects.toThrow('Resource')
  })

  it('should throw ValidationError when resource has no file or URL', async () => {
    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue(makeResource({}))

    await expect(executeFetch('res-1', ctx)).rejects.toThrow('no file or URL')
  })

  it('should compute hash for upload resources when missing', async () => {
    const content = 'name,age\nAlice,30\n'
    const expectedHash = `sha256:${createHash('sha256').update(content).digest('hex')}`
    const ctx = createMockCtx()
    vi.mocked(ctx.storage.download).mockResolvedValue(Readable.from(Buffer.from(content)))
    vi.mocked(ctx.getResource).mockResolvedValue(makeResource({ urlType: 'upload' }))

    const result = await executeFetch('res-1', ctx)

    expect(result).toEqual({
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
      status: 'fetched',
    })
    expect(ctx.storage.upload).not.toHaveBeenCalled()
    expect(ctx.updateResourceHashAndSize).toHaveBeenCalledWith('res-1', {
      hash: expectedHash,
      size: content.length,
    })
  })

  it('should skip hash computation for upload resources when already set', async () => {
    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue(
      makeResource({ urlType: 'upload', hash: 'sha256:abc' })
    )

    const result = await executeFetch('res-1', ctx)

    expect(result.status).toBe('skipped')
    expect(ctx.storage.download).not.toHaveBeenCalled()
    expect(ctx.updateResourceHashAndSize).not.toHaveBeenCalled()
  })

  it('should stream from external URL to Storage and compute hash', async () => {
    const body = 'name,age\nAlice,30\n'
    const expectedHash = `sha256:${createHash('sha256').update(body).digest('hex')}`

    const mockResponse = new Response(body, {
      status: 200,
      headers: { 'content-length': String(body.length) },
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse)

    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue(
      makeResource({ url: 'https://example.com/data.csv' })
    )

    const result = await executeFetch('res-1', ctx)

    expect(result).toEqual({
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
      status: 'fetched',
    })
    expect(ctx.storage.upload).toHaveBeenCalledWith('resources/pkg-1/res-1', expect.any(Readable))
    expect(ctx.updateResourceHashAndSize).toHaveBeenCalledWith('res-1', {
      hash: expectedHash,
      size: body.length,
    })

    fetchSpy.mockRestore()
  })

  it('should not update hash when unchanged', async () => {
    const body = 'data'
    const existingHash = `sha256:${createHash('sha256').update(body).digest('hex')}`

    const mockResponse = new Response(body, { status: 200 })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse)

    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue(
      makeResource({ url: 'https://example.com/data.csv', hash: existingHash })
    )

    await executeFetch('res-1', ctx)

    expect(ctx.updateResourceHashAndSize).not.toHaveBeenCalled()

    fetchSpy.mockRestore()
  })

  it('should throw on HTTP error response', async () => {
    const mockResponse = new Response(null, { status: 404 })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse)

    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue(
      makeResource({ url: 'https://example.com/not-found.csv' })
    )

    await expect(executeFetch('res-1', ctx)).rejects.toThrow('Failed to fetch')

    fetchSpy.mockRestore()
  })

  it('should throw when Content-Length exceeds limit', async () => {
    const mockResponse = new Response('x', {
      status: 200,
      headers: { 'content-length': String(200 * 1024 * 1024) },
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse)

    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue(
      makeResource({ url: 'https://example.com/big.csv' })
    )

    await expect(executeFetch('res-1', ctx)).rejects.toThrow('100MB limit')

    fetchSpy.mockRestore()
  })

  it('should throw when streaming size exceeds limit', async () => {
    // Create a response that streams more than 100MB without Content-Length
    const bigChunk = Buffer.alloc(60 * 1024 * 1024, 'x')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bigChunk)
        controller.enqueue(bigChunk) // total = 120MB > 100MB
        controller.close()
      },
    })
    const mockResponse = new Response(stream, { status: 200 })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse)

    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue(
      makeResource({ url: 'https://example.com/big.csv' })
    )

    await expect(executeFetch('res-1', ctx)).rejects.toThrow('100MB limit')

    fetchSpy.mockRestore()
  })

  it('should return correct format and packageId', async () => {
    const ctx = createMockCtx()
    vi.mocked(ctx.storage.download).mockResolvedValue(Readable.from(Buffer.from('test')))
    vi.mocked(ctx.getResource).mockResolvedValue(
      makeResource({ packageId: 'pkg-99', urlType: 'upload', format: 'JSON' })
    )

    const result = await executeFetch('res-1', ctx)

    expect(result.status).toBe('fetched')
    expect(result).toMatchObject({
      format: 'JSON',
      packageId: 'pkg-99',
      storageKey: 'resources/pkg-99/res-1',
    })
  })

  it('should return deferred when rate-limited', async () => {
    const ctx = createMockCtx()
    vi.mocked(ctx.acquireFetchSlot).mockResolvedValue(false)
    vi.mocked(ctx.getResource).mockResolvedValue(
      makeResource({ url: 'https://example.com/data.csv' })
    )

    const result = await executeFetch('res-1', ctx)

    expect(result).toEqual({ status: 'deferred' })
    expect(ctx.acquireFetchSlot).toHaveBeenCalledWith('example.com')
    expect(ctx.storage.upload).not.toHaveBeenCalled()
  })

  it('should not check rate limit for uploads', async () => {
    const ctx = createMockCtx()
    vi.mocked(ctx.storage.download).mockResolvedValue(Readable.from(Buffer.from('test')))
    vi.mocked(ctx.getResource).mockResolvedValue(makeResource({ urlType: 'upload' }))

    await executeFetch('res-1', ctx)

    expect(ctx.acquireFetchSlot).not.toHaveBeenCalled()
  })
})
