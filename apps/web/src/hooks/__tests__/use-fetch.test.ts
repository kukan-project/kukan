import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { useFetch } from '../use-fetch'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

describe('useFetch', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
  })

  it('should start in loading state', () => {
    mockClientFetch.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useFetch('/api/v1/test'))
    expect(result.current.loading).toBe(true)
    expect(result.current.data).toBeNull()
    expect(result.current.error).toBe(false)
  })

  it('should fetch data on mount', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ items: [1, 2, 3] }))

    const { result } = renderHook(() => useFetch<{ items: number[] }>('/api/v1/test'))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.data).toEqual({ items: [1, 2, 3] })
    expect(result.current.error).toBe(false)
  })

  it('should set error on non-ok response', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse(null, false))

    const { result } = renderHook(() => useFetch('/api/v1/test'))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.error).toBe(true)
    expect(result.current.data).toBeNull()
  })

  it('should set error on network failure', async () => {
    mockClientFetch.mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useFetch('/api/v1/test'))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.error).toBe(true)
  })

  it('should refetch when path changes', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ v: 1 }))

    const { result, rerender } = renderHook(({ path }) => useFetch(path), {
      initialProps: { path: '/api/v1/a' },
    })

    await waitFor(() => {
      expect(result.current.data).toEqual({ v: 1 })
    })

    mockClientFetch.mockResolvedValue(jsonResponse({ v: 2 }))
    rerender({ path: '/api/v1/b' })

    await waitFor(() => {
      expect(result.current.data).toEqual({ v: 2 })
    })
    expect(mockClientFetch).toHaveBeenCalledTimes(2)
  })

  it('should pass abort signal to clientFetch', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({}))

    renderHook(() => useFetch('/api/v1/test'))

    await waitFor(() => {
      expect(mockClientFetch).toHaveBeenCalled()
    })
    const call = mockClientFetch.mock.calls[0]
    expect(call[1]?.signal).toBeInstanceOf(AbortSignal)
  })
})
