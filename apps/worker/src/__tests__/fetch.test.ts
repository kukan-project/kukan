import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'crypto'
import { Readable } from 'stream'
import { executeFetch } from '../pipeline/steps/fetch'
import { MAX_FETCH_SIZE } from '../config'
import type { ResourceForPipeline } from '../pipeline/types'
import {
  createPipelineContextMock,
  type PipelineContextMock,
} from './test-helpers/pipeline-context'

// The real class, not a copy: `executeFetch` decides on `instanceof`, so a
// second declaration would let the mapping below pass while production's
// refusal fell through as an error.
const { HopRefusedError } = await vi.importActual<typeof import('@/safe-fetch')>('@/safe-fetch')

// Mock safeFetch to use globalThis.fetch directly (SSRF logic tested separately)
const safeFetchImpl = vi.hoisted(() => ({
  run: (...args: unknown[]) => globalThis.fetch(...(args as Parameters<typeof fetch>)),
}))
vi.mock('@/safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/safe-fetch')>()),
  safeFetch: (...args: unknown[]) => safeFetchImpl.run(...args),
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

/** The shared mock, with a putObject that consumes the stream as a real write would */
function createMockCtx(): PipelineContextMock {
  const ctx = createPipelineContextMock()
  ctx.putObject.mockImplementation(async (_key: string, body: Buffer | Readable) => {
    if (body instanceof Readable) {
      await streamToBuffer(body)
    }
  })
  return ctx
}

/** What `safeFetch` does unless a case replaces it. */
const passThrough = (...args: unknown[]) => globalThis.fetch(...(args as Parameters<typeof fetch>))

describe('executeFetch', () => {
  // Restored between cases: a case that swaps the implementation would
  // otherwise leave it swapped for every case after it.
  beforeEach(() => {
    safeFetchImpl.run = passThrough
  })

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
    expect(ctx.putObject).not.toHaveBeenCalled()
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
    // Version create records this value against the bytes it copies (ADR-043),
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
    const ctx = createMockCtx()
    ctx.publishContent.mockResolvedValue(false)
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
    const writtenKey = vi.mocked(ctx.putObject).mock.calls[0][0]
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

    expect(ctx.putObject).not.toHaveBeenCalledWith(
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
    expect(ctx.putObject).not.toHaveBeenCalled()
  })

  it('should ask for a slot for every host a redirect reaches', async () => {
    // The registered host's slot is taken above; the chain's own hosts are
    // taken as it goes, or the limit only ever sees the host an attacker is
    // happy for it to see.
    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue(
      makeResource({ url: 'https://example.com/data.csv' })
    )
    let asked: string[] = []
    safeFetchImpl.run = async (_url, _init, hooks) => {
      await (hooks as { onHost?(h: string): Promise<boolean> })?.onHost?.('cdn.example.net')
      asked = vi.mocked(ctx.acquireFetchSlot).mock.calls.map((c) => c[0])
      return new Response('data')
    }

    await executeFetch('res-1', ctx)

    expect(asked).toEqual(['example.com', 'cdn.example.net'])
  })

  it.each([
    ['an error status', () => new Response('an error page', { status: 404 })],
    [
      'a declared size over the limit',
      () =>
        new Response('too much', {
          status: 200,
          headers: { 'content-length': String(MAX_FETCH_SIZE + 1) },
        }),
    ],
  ])('should release the body when refusing on %s', async (_label, make) => {
    // Neither refusal reads the body, and an unread body holds a connection on
    // the Agent every fetch in the worker shares. The size branch is the one an
    // attacker reaches deliberately: declare a length nobody accepts, and the
    // bytes keep arriving on a socket nothing else can have.
    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue(
      makeResource({ url: 'https://example.com/data.csv' })
    )
    const response = make()
    safeFetchImpl.run = () => Promise.resolve(response)

    await expect(executeFetch('res-1', ctx)).rejects.toThrow()

    expect(response.bodyUsed).toBe(true)
  })

  it('should defer when a redirect target is over its own limit', async () => {
    // Not a broken link: the resource is fine and the run is worth retrying,
    // which is the same answer the registered host being busy gets.
    const ctx = createMockCtx()
    vi.mocked(ctx.getResource).mockResolvedValue(
      makeResource({ url: 'https://example.com/data.csv' })
    )
    safeFetchImpl.run = () => Promise.reject(new HopRefusedError('victim.example.net'))

    const result = await executeFetch('res-1', ctx)

    expect(result).toEqual({ status: 'deferred' })
    expect(ctx.publishContent).not.toHaveBeenCalled()
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
