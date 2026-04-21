import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { useSiteSettings } from '../use-site-settings'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

describe('useSiteSettings', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
  })

  it('should return loading state initially', () => {
    mockClientFetch.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useSiteSettings())
    expect(result.current.loading).toBe(true)
    expect(result.current.registrationEnabled).toBeNull()
  })

  it('should return registrationEnabled from API', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ registrationEnabled: true }))

    const { result } = renderHook(() => useSiteSettings())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.registrationEnabled).toBe(true)
  })

  it('should return registrationEnabled false from API', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ registrationEnabled: false }))

    const { result } = renderHook(() => useSiteSettings())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.registrationEnabled).toBe(false)
  })

  it('should default to true on error', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse(null, false))

    const { result } = renderHook(() => useSiteSettings())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.registrationEnabled).toBe(true)
  })
})
