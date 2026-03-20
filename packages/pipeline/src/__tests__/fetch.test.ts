import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { readFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'
import { fetchStep } from '../steps/fetch'
import type { PipelineContext } from '../types'

function createMockCtx(overrides?: Partial<PipelineContext>): PipelineContext {
  return {
    storage: { download: vi.fn(), upload: vi.fn() },
    search: { index: vi.fn() },
    getResource: vi.fn(),
    updateResourceHash: vi.fn(),
    getPackageForIndex: vi.fn(),
    ...overrides,
  }
}

describe('fetchStep', () => {
  const tmpFile = join(tmpdir(), `kukan-fetch-test-${process.pid}`)

  afterEach(async () => {
    await unlink(tmpFile).catch(() => {})
  })

  it('should throw NotFoundError when resource not found', async () => {
    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue(null)

    await expect(fetchStep('nonexistent', ctx, tmpFile)).rejects.toThrow('Resource')
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

    await expect(fetchStep('res-1', ctx, tmpFile)).rejects.toThrow('no file or URL')
  })

  it('should download from storage for upload resources', async () => {
    const content = Buffer.from('hello,world\n1,2\n')
    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue({
      id: 'res-1',
      packageId: 'pkg-1',
      url: null,
      urlType: 'upload',
      format: 'CSV',
      hash: null,
    })
    vi.mocked(ctx.storage.download).mockResolvedValue(Readable.from(content))

    const result = await fetchStep('res-1', ctx, tmpFile)

    expect(ctx.storage.download).toHaveBeenCalledWith('resources/pkg-1/res-1')
    expect(result).toEqual({ tmpFile, format: 'CSV', packageId: 'pkg-1' })

    const written = await readFile(tmpFile)
    expect(written.toString()).toBe('hello,world\n1,2\n')
  })

  it('should download from external URL and compute hash', async () => {
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

    const result = await fetchStep('res-1', ctx, tmpFile)

    expect(result).toEqual({ tmpFile, format: 'CSV', packageId: 'pkg-1' })
    expect(ctx.updateResourceHash).toHaveBeenCalledWith('res-1', expectedHash)

    const written = await readFile(tmpFile, 'utf-8')
    expect(written).toBe(body)

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

    await fetchStep('res-1', ctx, tmpFile)

    expect(ctx.updateResourceHash).not.toHaveBeenCalled()

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

    await expect(fetchStep('res-1', ctx, tmpFile)).rejects.toThrow('Failed to fetch')

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

    await expect(fetchStep('res-1', ctx, tmpFile)).rejects.toThrow('10MB limit')

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

    await expect(fetchStep('res-1', ctx, tmpFile)).rejects.toThrow('10MB limit')
    // Temp file should be cleaned up on error
    expect(existsSync(tmpFile)).toBe(false)

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
    vi.mocked(ctx.storage.download).mockResolvedValue(Readable.from(Buffer.from('{}')))

    const result = await fetchStep('res-1', ctx, tmpFile)

    expect(result.format).toBe('JSON')
    expect(result.packageId).toBe('pkg-99')
  })
})
