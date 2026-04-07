import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeHeadCheck } from '../../health-check/head-request'
import type { ResourceForHealthCheck } from '../../health-check/types'

function makeResource(overrides: Partial<ResourceForHealthCheck> = {}): ResourceForHealthCheck {
  return {
    id: 'res-1',
    url: 'https://example.com/data.csv',
    hash: 'sha256:abc123',
    healthStatus: 'unknown',
    healthCheckedAt: null,
    extras: {},
    ...overrides,
  }
}

describe('executeHeadCheck', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('returns ok for 200 response', async () => {
    fetchSpy.mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { etag: '"v1"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
      })
    )

    const result = await executeHeadCheck(makeResource())

    expect(result.healthStatus).toBe('ok')
    expect(result.httpStatus).toBe(200)
    expect(result.etag).toBe('"v1"')
    expect(result.lastModified).toBe('Mon, 01 Jan 2024 00:00:00 GMT')
    expect(result.changed).toBe(false)
    expect(result.errorMessage).toBeNull()
  })

  it('detects change when ETag differs', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200, headers: { etag: '"v2"' } }))

    const result = await executeHeadCheck(makeResource({ extras: { healthEtag: '"v1"' } }))

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

    const result = await executeHeadCheck(
      makeResource({ extras: { healthLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' } })
    )

    expect(result.healthStatus).toBe('ok')
    expect(result.changed).toBe(true)
  })

  it('returns no change when headers match', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200, headers: { etag: '"v1"' } }))

    const result = await executeHeadCheck(makeResource({ extras: { healthEtag: '"v1"' } }))

    expect(result.changed).toBe(false)
  })

  it('returns no change when no headers to compare', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))

    const result = await executeHeadCheck(makeResource())

    expect(result.healthStatus).toBe('ok')
    expect(result.etag).toBeNull()
    expect(result.lastModified).toBeNull()
    expect(result.changed).toBe(false)
  })

  it('returns error for 404 response', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404, statusText: 'Not Found' }))

    const result = await executeHeadCheck(makeResource())

    expect(result.healthStatus).toBe('error')
    expect(result.httpStatus).toBe(404)
    expect(result.errorMessage).toBe('HTTP 404 Not Found')
    expect(result.changed).toBe(false)
  })

  it('returns error for 500 response', async () => {
    fetchSpy.mockResolvedValue(
      new Response(null, { status: 500, statusText: 'Internal Server Error' })
    )

    const result = await executeHeadCheck(makeResource())

    expect(result.healthStatus).toBe('error')
    expect(result.httpStatus).toBe(500)
  })

  it('returns error on network failure', async () => {
    fetchSpy.mockRejectedValue(new Error('getaddrinfo ENOTFOUND example.com'))

    const result = await executeHeadCheck(makeResource())

    expect(result.healthStatus).toBe('error')
    expect(result.httpStatus).toBeNull()
    expect(result.errorMessage).toBe('getaddrinfo ENOTFOUND example.com')
    expect(result.changed).toBe(false)
  })

  it('returns error on timeout', async () => {
    fetchSpy.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'))

    const result = await executeHeadCheck(makeResource())

    expect(result.healthStatus).toBe('error')
    expect(result.httpStatus).toBeNull()
    expect(result.errorMessage).toBe('The operation was aborted')
  })

  it('uses HEAD method', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))

    await executeHeadCheck(makeResource())

    expect(fetchSpy).toHaveBeenCalledWith('https://example.com/data.csv', {
      method: 'HEAD',
      signal: expect.any(AbortSignal),
      redirect: 'follow',
    })
  })
})
