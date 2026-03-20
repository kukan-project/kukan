import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'crypto'
import { Readable } from 'stream'
import { fetchStep } from '../steps/fetch'
import type { PipelineContext } from '../types'

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
        // Consume the stream so the Transform pipeline completes
        if (body instanceof Readable) {
          await streamToBuffer(body)
        }
      }),
    },
    search: { index: vi.fn() },
    getResource: vi.fn(),
    updateResourceHashAndSize: vi.fn(),
    getPackageForIndex: vi.fn(),
    ...overrides,
  }
}

describe('fetchStep', () => {
  it('should throw NotFoundError when resource not found', async () => {
    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue(null)

    await expect(fetchStep('nonexistent', ctx)).rejects.toThrow('Resource')
  })

  it('should throw ValidationError when resource has no file or URL', async () => {
    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue({
      id: 'res-1',
      packageId: 'pkg-1',
      url: null,
      urlType: null,
      format: 'CSV',
      hash: null,
    })

    await expect(fetchStep('res-1', ctx)).rejects.toThrow('no file or URL')
  })

  it('should skip storage operations for upload resources', async () => {
    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue({
      id: 'res-1',
      packageId: 'pkg-1',
      url: null,
      urlType: 'upload',
      format: 'CSV',
      hash: null,
    })

    const result = await fetchStep('res-1', ctx)

    expect(result).toEqual({
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
    })
    // Should not upload (data already in Storage)
    expect(ctx.storage.upload).not.toHaveBeenCalled()
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
    vi.mocked(ctx.getResource).mockResolvedValue({
      id: 'res-1',
      packageId: 'pkg-1',
      url: 'https://example.com/data.csv',
      urlType: null,
      format: 'CSV',
      hash: null,
    })

    const result = await fetchStep('res-1', ctx)

    expect(result).toEqual({
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
    })
    // Verify upload was called with correct key and a stream
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
    vi.mocked(ctx.getResource).mockResolvedValue({
      id: 'res-1',
      packageId: 'pkg-1',
      url: 'https://example.com/data.csv',
      urlType: null,
      format: 'CSV',
      hash: existingHash,
    })

    await fetchStep('res-1', ctx)

    expect(ctx.updateResourceHashAndSize).not.toHaveBeenCalled()

    fetchSpy.mockRestore()
  })

  it('should throw on HTTP error response', async () => {
    const mockResponse = new Response(null, { status: 404 })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse)

    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue({
      id: 'res-1',
      packageId: 'pkg-1',
      url: 'https://example.com/not-found.csv',
      urlType: null,
      format: 'CSV',
      hash: null,
    })

    await expect(fetchStep('res-1', ctx)).rejects.toThrow('Failed to fetch')

    fetchSpy.mockRestore()
  })

  it('should throw when Content-Length exceeds limit', async () => {
    const mockResponse = new Response('x', {
      status: 200,
      headers: { 'content-length': String(20 * 1024 * 1024) },
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse)

    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue({
      id: 'res-1',
      packageId: 'pkg-1',
      url: 'https://example.com/big.csv',
      urlType: null,
      format: 'CSV',
      hash: null,
    })

    await expect(fetchStep('res-1', ctx)).rejects.toThrow('10MB limit')

    fetchSpy.mockRestore()
  })

  it('should throw when streaming size exceeds limit', async () => {
    // Create a response that streams more than 10MB without Content-Length
    const bigChunk = Buffer.alloc(6 * 1024 * 1024, 'x')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bigChunk)
        controller.enqueue(bigChunk) // total = 12MB > 10MB
        controller.close()
      },
    })
    const mockResponse = new Response(stream, { status: 200 })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse)

    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue({
      id: 'res-1',
      packageId: 'pkg-1',
      url: 'https://example.com/big.csv',
      urlType: null,
      format: 'CSV',
      hash: null,
    })

    await expect(fetchStep('res-1', ctx)).rejects.toThrow('10MB limit')

    fetchSpy.mockRestore()
  })

  it('should return correct format and packageId', async () => {
    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue({
      id: 'res-1',
      packageId: 'pkg-99',
      url: null,
      urlType: 'upload',
      format: 'JSON',
      hash: null,
    })

    const result = await fetchStep('res-1', ctx)

    expect(result.format).toBe('JSON')
    expect(result.packageId).toBe('pkg-99')
    expect(result.storageKey).toBe('resources/pkg-99/res-1')
  })
})
