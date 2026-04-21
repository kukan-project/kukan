import { describe, it, expect, vi, beforeEach } from 'vitest'
import { clientFetch } from '../client-api'

describe('clientFetch', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('should call fetch with credentials include', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', mockFetch)

    await clientFetch('/api/v1/packages')

    expect(mockFetch).toHaveBeenCalledWith('/api/v1/packages', {
      credentials: 'include',
    })
  })

  it('should merge custom init options', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', mockFetch)

    await clientFetch('/api/v1/packages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })

    expect(mockFetch).toHaveBeenCalledWith('/api/v1/packages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    })
  })

  it('should return the fetch response', async () => {
    const response = new Response(JSON.stringify({ id: '1' }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const result = await clientFetch('/api/v1/packages')
    expect(result).toBe(response)
  })
})
