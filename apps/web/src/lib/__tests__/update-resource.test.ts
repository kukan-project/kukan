import { describe, it, expect, vi, beforeEach } from 'vitest'
import { clientFetch } from '@/lib/client-api'
import { updateResource } from '../update-resource'

vi.mock('@/lib/client-api', () => ({ clientFetch: vi.fn() }))
const mockClientFetch = vi.mocked(clientFetch)

const jsonResponse = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response

describe('updateResource', () => {
  beforeEach(() => mockClientFetch.mockReset())

  it('merges the patch over the current record and PUTs, preserving other fields', async () => {
    // GET current, then PUT
    mockClientFetch
      .mockResolvedValueOnce(
        jsonResponse({ id: 'r1', name: 'old', description: 'd', format: 'csv', size: 42 })
      )
      .mockResolvedValueOnce(jsonResponse({}))

    const ok = await updateResource('r1', { name: 'new' })

    expect(ok).toBe(true)
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

  it('returns false and does not PUT when the current record cannot be fetched', async () => {
    mockClientFetch.mockResolvedValueOnce(jsonResponse({}, false))

    const ok = await updateResource('r1', { name: 'new' })

    expect(ok).toBe(false)
    expect(mockClientFetch).toHaveBeenCalledTimes(1) // GET only, no PUT
  })

  it('returns false when the PUT fails', async () => {
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse({ id: 'r1', name: 'old' }))
      .mockResolvedValueOnce(jsonResponse({}, false))

    expect(await updateResource('r1', { name: 'new' })).toBe(false)
  })
})
