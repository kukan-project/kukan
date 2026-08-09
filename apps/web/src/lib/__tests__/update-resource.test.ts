import { describe, it, expect, vi, beforeEach } from 'vitest'
import { clientFetch } from '@/lib/client-api'
import { updateResource } from '../update-resource'

// Only the transport is stubbed. `problemDetail` reads a Response and nothing
// else, so the real one is what these cases should be exercising.
vi.mock('@/lib/client-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/client-api')>()),
  clientFetch: vi.fn(),
}))
const mockClientFetch = vi.mocked(clientFetch)

const jsonResponse = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response

/** A failure whose body is not JSON — an edge page, a proxy, a truncated write. */
const brokenResponse = () =>
  ({
    ok: false,
    json: async () => {
      throw new SyntaxError('Unexpected token')
    },
  }) as unknown as Response

describe('updateResource', () => {
  beforeEach(() => mockClientFetch.mockReset())

  it('merges the patch over the current record and PUTs, preserving other fields', async () => {
    // GET current, then PUT
    mockClientFetch
      .mockResolvedValueOnce(
        jsonResponse({ id: 'r1', name: 'old', description: 'd', format: 'csv', size: 42 })
      )
      .mockResolvedValueOnce(jsonResponse({}))

    const result = await updateResource('r1', { name: 'new' })

    expect(result).toEqual({ ok: true })
    const [path, init] = mockClientFetch.mock.calls[1]
    expect(path).toBe('/api/v1/resources/r1')
    expect(init!.method).toBe('PUT')
    // Non-patched fields survive the full-replace PUT; name is overwritten
    expect(JSON.parse(init!.body as string)).toEqual({
      id: 'r1',
      name: 'new',
      description: 'd',
      format: 'csv',
      size: 42,
    })
  })

  it('reports failure and does not PUT when the current record cannot be fetched', async () => {
    mockClientFetch.mockResolvedValueOnce(jsonResponse({}, false))

    const result = await updateResource('r1', { name: 'new' })

    expect(result.ok).toBe(false)
    expect(mockClientFetch).toHaveBeenCalledTimes(1) // GET only, no PUT
  })

  it("carries back the server's reason when the PUT fails", async () => {
    // The point of the whole return shape: the API names the field and the
    // reason, and a boolean threw that away, so every failed edit read "could
    // not update".
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse({ id: 'r1', name: 'old' }))
      .mockResolvedValueOnce(jsonResponse({ detail: 'url: Invalid URL' }, false))

    expect(await updateResource('r1', { name: 'new' })).toEqual({
      ok: false,
      detail: 'url: Invalid URL',
    })
  })

  it('reports failure without a reason when the body carries none', async () => {
    // Callers fall back to their own wording, so `detail` has to be absent
    // rather than an empty string they would show as a blank message.
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse({ id: 'r1', name: 'old' }))
      .mockResolvedValueOnce(jsonResponse({ detail: '' }, false))

    expect(await updateResource('r1', { name: 'new' })).toEqual({ ok: false, detail: undefined })
  })

  it('reports failure when the error body is not JSON', async () => {
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse({ id: 'r1', name: 'old' }))
      .mockResolvedValueOnce(brokenResponse())

    expect(await updateResource('r1', { name: 'new' })).toEqual({ ok: false, detail: undefined })
  })
})
