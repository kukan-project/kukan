import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'crypto'
import { Readable } from 'stream'
import { executeFetch } from '../pipeline/steps/fetch'
import type { PipelineContext, ResourceForPipeline } from '../pipeline/types'

// Mock safeFetch to use globalThis.fetch directly (SSRF logic tested separately)
vi.mock('@/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => globalThis.fetch(...(args as Parameters<typeof fetch>)),
}))

/** Keys a run mints carry a random token; assertions match on the shape. */
const RUN_KEY = /^resources\/pkg-1\/res-1\.[0-9a-f-]{36}$/

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
    size: null,
    storageKey: null,
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
    publishContent: vi.fn().mockResolvedValue(true),
    acquireFetchSlot: vi.fn().mockResolvedValue(true),
    indexContent: vi.fn(),
    deleteContent: vi.fn(),
    updatePipelineMetadata: vi.fn(),
    ...overrides,
  } as unknown as PipelineContext
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
    vi.mocked(ctx.getResource).mockResolvedValue(
      makeResource({ urlType: 'upload', storageKey: 'resources/pkg-1/res-1.upload' })
    )

    const result = await executeFetch('res-1', ctx)

    expect(result).toEqual({
      storageKey: 'resources/pkg-1/res-1.upload',
      format: 'CSV',
      packageId: 'pkg-1',
      hash: expectedHash,
      size: content.length,
      status: 'fetched',
    })
    expect(ctx.storage.upload).not.toHaveBeenCalled()
    // Same key in and out: `upload-complete` already moved the pointer here.
    expect(ctx.publishContent).toHaveBeenCalledWith('res-1', {
      key: 'resources/pkg-1/res-1.upload',
      previousKey: 'resources/pkg-1/res-1.upload',
      hash: expectedHash,
      size: content.length,
      previousHash: null,
    })
  })

  it('recomputes the hash of an upload rather than trusting the stored one', async () => {
    // Version capture records this value against the bytes it copies (ADR-043),
    // so a stale or client-supplied one would decide what a version claims.
    const content = 'name,age\nAlice,30\n'
    const expectedHash = `sha256:${createHash('sha256').update(content).digest('hex')}`
    const ctx = createMockCtx()
    vi.mocked(ctx.storage.download).mockResolvedValue(Readable.from(Buffer.from(content)))
    vi.mocked(ctx.getResource).mockResolvedValue(
      makeResource({
        urlType: 'upload',
        hash: 'sha256:not-the-real-hash',
        storageKey: 'resources/pkg-1/res-1.upload',
      })
    )

    const result = await executeFetch('res-1', ctx)

    expect(result.status).toBe('fetched')
    expect(ctx.publishContent).toHaveBeenCalledWith(
      'res-1',
      expect.objectContaining({ hash: expectedHash, previousHash: 'sha256:not-the-real-hash' })
    )
  })

  it('reports superseded when another run moved the pointer first', async () => {
    // The pointer is the resource's identity: a run that lost it must not carry
    // on and attribute a version to bytes that are no longer the content.
    const ctx = createMockCtx({ publishContent: vi.fn().mockResolvedValue(false) })
    vi.mocked(ctx.storage.download).mockResolvedValue(Readable.from(Buffer.from('data')))
    vi.mocked(ctx.getResource).mockResolvedValue(
      makeResource({ urlType: 'upload', storageKey: 'resources/pkg-1/res-1.upload' })
    )

    expect(await executeFetch('res-1', ctx)).toEqual({ status: 'superseded' })
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

    expect(result).toMatchObject({
      format: 'CSV',
      packageId: 'pkg-1',
      hash: expectedHash,
      size: body.length,
      status: 'fetched',
    })
    // The bytes go to a key of this run's own, not the shared one.
    const writtenKey = vi.mocked(ctx.storage.upload).mock.calls[0][0]
    expect(writtenKey).toMatch(RUN_KEY)
    expect((result as { storageKey: string }).storageKey).toBe(writtenKey)

    fetchSpy.mockRestore()
  })

  it('leaves the previous object in place until the new bytes are complete', async () => {
    // The write targets a fresh key, so a resource that has content keeps
    // serving it whatever happens to this run (ADR-043).
    const body = 'data'
    const hash = `sha256:${createHash('sha256').update(body).digest('hex')}`

    const mockResponse = new Response(body, { status: 200 })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse)

    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue(
      makeResource({
        url: 'https://example.com/data.csv',
        hash,
        storageKey: 'resources/pkg-1/res-1.previous',
      })
    )

    await executeFetch('res-1', ctx)

    expect(ctx.storage.upload).not.toHaveBeenCalledWith(
      'resources/pkg-1/res-1.previous',
      expect.anything()
    )
    expect(ctx.publishContent).toHaveBeenCalledWith('res-1', {
      key: expect.stringMatching(RUN_KEY),
      previousKey: 'resources/pkg-1/res-1.previous',
      hash,
      size: body.length,
      previousHash: hash,
    })

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
    expect(ctx.publishContent).not.toHaveBeenCalled()

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
      makeResource({
        packageId: 'pkg-99',
        urlType: 'upload',
        format: 'JSON',
        storageKey: 'resources/pkg-99/res-1.upload',
      })
    )

    const result = await executeFetch('res-1', ctx)

    expect(result.status).toBe('fetched')
    expect(result).toMatchObject({
      format: 'JSON',
      packageId: 'pkg-99',
      storageKey: 'resources/pkg-99/res-1.upload',
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
    vi.mocked(ctx.getResource).mockResolvedValue(
      makeResource({ urlType: 'upload', storageKey: 'resources/pkg-1/res-1.upload' })
    )

    await executeFetch('res-1', ctx)

    expect(ctx.acquireFetchSlot).not.toHaveBeenCalled()
  })
})
