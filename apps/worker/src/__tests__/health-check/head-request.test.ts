import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeHeadCheck } from '../../cron/health-check/head-request'
import { HopRefusedError } from '../../safe-fetch'
import type { ResourceForHealthCheck } from '../../cron/health-check/types'

// Mock safeFetch to use globalThis.fetch directly (SSRF logic tested separately).
// `discardBody` is the real one: what it does to the response is the point of
// the case below, and a stub would assert nothing.
vi.mock('@/safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/safe-fetch')>()),
  safeFetch: (...args: unknown[]) => globalThis.fetch(...(args as Parameters<typeof fetch>)),
}))

function makeResource(overrides: Partial<ResourceForHealthCheck> = {}): ResourceForHealthCheck {
  return {
    id: 'res-1',
    url: 'https://example.com/data.csv',
    hash: 'sha256:abc123',
    healthStatus: 'unknown',
    healthCheckedAt: null,
    healthCheckState: {},
    ...overrides,
  }
}

/** Answers null only when a redirect target is out of the batch's budget,
 *  which is arranged by exactly one case below. */
const check = async (...args: Parameters<typeof executeHeadCheck>) =>
  (await executeHeadCheck(...args))!

describe('executeHeadCheck', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('releases a body a HEAD was answered with', async () => {
    // Nothing here reads one, and servers do send them. Left unread it holds a
    // connection on the Agent every fetch in the worker shares, and this runs
    // over 200 URLs a tick.
    const answered = new Response('a body on a HEAD', { status: 200 })
    fetchSpy.mockResolvedValue(answered)

    const result = await check(makeResource())

    expect(result.healthStatus).toBe('ok')
    expect(answered.bodyUsed).toBe(true)
  })

  it('returns ok for 200 response', async () => {
    fetchSpy.mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { etag: '"v1"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
      })
    )

    const result = await check(makeResource())

    expect(result.healthStatus).toBe('ok')
    expect(result.httpStatus).toBe(200)
    expect(result.etag).toBe('"v1"')
    expect(result.lastModified).toBe('Mon, 01 Jan 2024 00:00:00 GMT')
    expect(result.changed).toBe(false)
    expect(result.errorMessage).toBeNull()
  })

  it('detects change when ETag differs', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200, headers: { etag: '"v2"' } }))

    const result = await check(makeResource({ healthCheckState: { etag: '"v1"' } }))

    expect(result.healthStatus).toBe('ok')
    expect(result.changed).toBe(true)
  })

  it('detects change when Last-Modified differs', async () => {
    fetchSpy.mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { 'last-modified': 'Tue, 02 Jan 2024 00:00:00 GMT' },
      })
    )

    const result = await check(
      makeResource({ healthCheckState: { lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' } })
    )

    expect(result.healthStatus).toBe('ok')
    expect(result.changed).toBe(true)
  })

  it('returns no change when headers match', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200, headers: { etag: '"v1"' } }))

    const result = await check(makeResource({ healthCheckState: { etag: '"v1"' } }))

    expect(result.changed).toBe(false)
  })

  it('returns no change when no headers to compare', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))

    const result = await check(makeResource())

    expect(result.healthStatus).toBe('ok')
    expect(result.etag).toBeNull()
    expect(result.lastModified).toBeNull()
    expect(result.changed).toBe(false)
  })

  it('returns error for 404 response', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404, statusText: 'Not Found' }))

    const result = await check(makeResource())

    expect(result.healthStatus).toBe('error')
    expect(result.httpStatus).toBe(404)
    expect(result.errorMessage).toBe('HTTP 404 Not Found')
    expect(result.changed).toBe(false)
  })

  it('returns error for 500 response', async () => {
    fetchSpy.mockResolvedValue(
      new Response(null, { status: 500, statusText: 'Internal Server Error' })
    )

    const result = await check(makeResource())

    expect(result.healthStatus).toBe('error')
    expect(result.httpStatus).toBe(500)
  })

  it('returns error on network failure', async () => {
    fetchSpy.mockRejectedValue(new Error('getaddrinfo ENOTFOUND example.com'))

    const result = await check(makeResource())

    expect(result.healthStatus).toBe('error')
    expect(result.httpStatus).toBeNull()
    expect(result.errorMessage).toBe('getaddrinfo ENOTFOUND example.com')
    expect(result.changed).toBe(false)
  })

  it('keeps the address it tried out of the row and puts it in the detail', async () => {
    // The row keeps what it says until the URL is checked again, and a
    // split-horizon name resolves to an address that is nobody's business but
    // this process's. The log ages out; the row does not.
    fetchSpy.mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 10.0.3.17:443') })
    )

    const result = await check(makeResource())

    expect(result.errorMessage).toBe('fetch failed')
    expect(result.errorDetail).toBe('connect ECONNREFUSED 10.0.3.17:443')
  })

  it('returns error on timeout', async () => {
    fetchSpy.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'))

    const result = await check(makeResource())

    expect(result.healthStatus).toBe('error')
    expect(result.httpStatus).toBeNull()
    expect(result.errorMessage).toBe('The operation was aborted')
  })

  it('uses HEAD method', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))

    await check(makeResource())

    // The third argument is the hooks `safeFetch` asks at each redirect hop;
    // the stub above forwards everything it is given.
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/data.csv',
      { method: 'HEAD', signal: expect.any(AbortSignal) },
      undefined
    )
  })

  it('reports a refused redirect target as nothing rather than as a dead link', async () => {
    // `safeFetch` throws this when a hop's host is refused. The resource is
    // fine; it simply was not asked, so the row must not be written.
    fetchSpy.mockRejectedValue(new HopRefusedError('cdn.example'))

    expect(await executeHeadCheck(makeResource())).toBeNull()
  })
})
