import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { usePaginatedFetch } from '../use-paginated-fetch'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

function mockResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

const page1 = { items: [{ id: '1' }, { id: '2' }], total: 5 }
const page2 = { items: [{ id: '3' }, { id: '4' }], total: 5 }

describe('usePaginatedFetch', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
  })

  it('should fetch the first page on mount', async () => {
    vi.mocked(clientFetch).mockResolvedValue(mockResponse(page1))

    const { result } = renderHook(() => usePaginatedFetch('/api/v1/packages'))

    // Initially loading
    expect(result.current.loading).toBe(true)

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.items).toEqual(page1.items)
    expect(result.current.total).toBe(5)
    expect(result.current.offset).toBe(0)
    expect(result.current.currentPage).toBe(1)
    expect(result.current.totalPages).toBe(1) // 5 items / 20 pageSize = 1 page
    expect(result.current.error).toBeNull()
    expect(clientFetch).toHaveBeenCalledWith('/api/v1/packages?limit=20&offset=0')
  })

  it('should use custom page size', async () => {
    vi.mocked(clientFetch).mockResolvedValue(mockResponse(page1))

    const { result } = renderHook(() => usePaginatedFetch('/api/v1/packages', 2))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.totalPages).toBe(3) // 5 items / 2 pageSize = 3 pages
    expect(clientFetch).toHaveBeenCalledWith('/api/v1/packages?limit=2&offset=0')
  })

  it('should append params correctly when URL has existing query string', async () => {
    vi.mocked(clientFetch).mockResolvedValue(mockResponse(page1))

    const { result } = renderHook(() => usePaginatedFetch('/api/v1/packages?owner_org=tokyo'))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(clientFetch).toHaveBeenCalledWith('/api/v1/packages?owner_org=tokyo&limit=20&offset=0')
  })

  it('should navigate to a different page via fetchPage', async () => {
    vi.mocked(clientFetch)
      .mockResolvedValueOnce(mockResponse(page1))
      .mockResolvedValueOnce(mockResponse(page2))

    const { result } = renderHook(() => usePaginatedFetch('/api/v1/packages', 2))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toEqual(page1.items)
    expect(result.current.currentPage).toBe(1)

    // Navigate to page 2 (offset=2)
    await act(async () => {
      await result.current.fetchPage(2)
    })

    expect(result.current.items).toEqual(page2.items)
    expect(result.current.offset).toBe(2)
    expect(result.current.currentPage).toBe(2)
    expect(clientFetch).toHaveBeenCalledWith('/api/v1/packages?limit=2&offset=2')
  })

  it('should keep previous data and set error on HTTP failure', async () => {
    vi.mocked(clientFetch)
      .mockResolvedValueOnce(mockResponse(page1))
      .mockResolvedValueOnce(mockResponse(null, false))

    const { result } = renderHook(() => usePaginatedFetch('/api/v1/packages', 2))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toEqual(page1.items)
    expect(result.current.error).toBeNull()

    // Failed fetch — items should remain unchanged, error should be set
    await act(async () => {
      await result.current.fetchPage(2)
    })

    expect(result.current.loading).toBe(false)
    expect(result.current.items).toEqual(page1.items)
    expect(result.current.offset).toBe(0) // offset unchanged
    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.error!.message).toMatch(/HTTP/)
  })

  it('should refetch when URL changes', async () => {
    vi.mocked(clientFetch)
      .mockResolvedValueOnce(mockResponse(page1))
      .mockResolvedValueOnce(mockResponse(page2))

    const { result, rerender } = renderHook(({ url }) => usePaginatedFetch(url), {
      initialProps: { url: '/api/v1/packages?q=foo' },
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toEqual(page1.items)

    // Change URL → should trigger new fetch from offset=0
    rerender({ url: '/api/v1/packages?q=bar' })

    await waitFor(() => expect(result.current.items).toEqual(page2.items))
    expect(clientFetch).toHaveBeenCalledWith('/api/v1/packages?q=bar&limit=20&offset=0')
  })

  it('should set loading during fetch', async () => {
    let resolvePromise: (res: Response) => void
    vi.mocked(clientFetch).mockReturnValue(
      new Promise((r) => {
        resolvePromise = r
      })
    )

    const { result } = renderHook(() => usePaginatedFetch('/api/v1/packages'))

    expect(result.current.loading).toBe(true)

    await act(async () => {
      resolvePromise!(mockResponse(page1))
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
  })

  it('should set error on network exception', async () => {
    vi.mocked(clientFetch).mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => usePaginatedFetch('/api/v1/packages'))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toEqual([])
    expect(result.current.total).toBe(0)
    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.error!.message).toBe('Network error')
  })

  it('should discard stale response when URL changes during flight (fresh first)', async () => {
    const staleData = { items: [{ id: 'stale' }], total: 1 }
    const freshData = { items: [{ id: 'fresh' }], total: 1 }

    let resolveA: (res: Response) => void
    let resolveB: (res: Response) => void

    vi.mocked(clientFetch)
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveA = r
        })
      ) // mount: url A
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveB = r
        })
      ) // rerender: url B

    const { result, rerender } = renderHook(({ url }) => usePaginatedFetch(url), {
      initialProps: { url: '/api/v1/packages?q=old' },
    })

    // URL changes before first request completes
    rerender({ url: '/api/v1/packages?q=new' })

    // New request (B) resolves first
    await act(async () => {
      resolveB!(mockResponse(freshData))
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toEqual(freshData.items)

    // Stale request (A) resolves later — should NOT overwrite
    await act(async () => {
      resolveA!(mockResponse(staleData))
    })
    expect(result.current.items).toEqual(freshData.items)
  })

  it('should discard stale response when URL changes during flight (stale first)', async () => {
    const staleData = { items: [{ id: 'stale' }], total: 1 }
    const freshData = { items: [{ id: 'fresh' }], total: 1 }

    let resolveA: (res: Response) => void
    let resolveB: (res: Response) => void

    vi.mocked(clientFetch)
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveA = r
        })
      ) // mount: url A
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveB = r
        })
      ) // rerender: url B

    const { result, rerender } = renderHook(({ url }) => usePaginatedFetch(url), {
      initialProps: { url: '/api/v1/packages?q=old' },
    })

    // URL changes before first request completes
    rerender({ url: '/api/v1/packages?q=new' })

    // Stale request (A) resolves first — should be discarded by cleanup invalidation
    await act(async () => {
      resolveA!(mockResponse(staleData))
    })
    expect(result.current.items).not.toEqual(staleData.items)

    // Fresh request (B) resolves — should be accepted
    await act(async () => {
      resolveB!(mockResponse(freshData))
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toEqual(freshData.items)
  })

  it('should discard stale response when fetchPage is called rapidly', async () => {
    const staleData = { items: [{ id: 'page2-stale' }], total: 10 }
    const freshData = { items: [{ id: 'page3-fresh' }], total: 10 }

    // Mount resolves immediately
    vi.mocked(clientFetch).mockResolvedValueOnce(mockResponse(page1))

    const { result } = renderHook(() => usePaginatedFetch('/api/v1/packages', 2))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // Set up two slow responses
    let resolvePage2: (res: Response) => void
    let resolvePage3: (res: Response) => void
    vi.mocked(clientFetch)
      .mockReturnValueOnce(
        new Promise((r) => {
          resolvePage2 = r
        })
      )
      .mockReturnValueOnce(
        new Promise((r) => {
          resolvePage3 = r
        })
      )

    // Fire two page navigations without awaiting
    act(() => {
      result.current.fetchPage(2)
    })
    act(() => {
      result.current.fetchPage(4)
    })

    // Page 3 (latest) resolves first
    await act(async () => {
      resolvePage3!(mockResponse(freshData))
    })
    await waitFor(() => expect(result.current.items).toEqual(freshData.items))

    // Page 2 (stale) resolves later — should NOT overwrite
    await act(async () => {
      resolvePage2!(mockResponse(staleData))
    })

    expect(result.current.items).toEqual(freshData.items)
    expect(result.current.offset).toBe(4)
  })

  it('should clear error on successful fetch', async () => {
    vi.mocked(clientFetch)
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(mockResponse(page1))

    const { result } = renderHook(() => usePaginatedFetch('/api/v1/packages'))

    // First fetch fails
    await waitFor(() => expect(result.current.error).not.toBeNull())

    // Retry succeeds
    await act(async () => {
      await result.current.fetchPage(0)
    })

    expect(result.current.error).toBeNull()
    expect(result.current.items).toEqual(page1.items)
  })
})
