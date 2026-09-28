import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { useLatestJson } from '../use-latest-json'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const ok = (data: unknown) => ({ ok: true, json: async () => data }) as Response

describe('useLatestJson', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
  })

  it('fetches on mount', async () => {
    vi.mocked(clientFetch).mockResolvedValue(ok({ n: 1 }))
    const { result } = renderHook(() => useLatestJson<{ n: number }>('/api/x'))

    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }))
    expect(clientFetch).toHaveBeenCalledWith('/api/x')
  })

  it('keeps the same value when the answer has not changed', async () => {
    vi.mocked(clientFetch).mockImplementation(async () => ok({ n: 1 }))
    const { result } = renderHook(() => useLatestJson<{ n: number }>('/api/x'))
    await waitFor(() => expect(result.current.data).not.toBeNull())
    const before = result.current.data

    await act(async () => {
      await result.current.fetch()
    })

    expect(result.current.data).toBe(before)
  })

  it('lets the latest request win', async () => {
    vi.mocked(clientFetch).mockResolvedValueOnce(ok({ n: 1 }))
    const { result } = renderHook(() => useLatestJson<{ n: number }>('/api/x'))
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }))

    let resolveOld: (res: Response) => void
    vi.mocked(clientFetch)
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveOld = r
        })
      )
      .mockResolvedValueOnce(ok({ n: 3 }))
    act(() => {
      result.current.fetch()
    })
    await act(async () => {
      await result.current.fetch()
    })
    await act(async () => {
      resolveOld!(ok({ n: 2 }))
    })

    expect(result.current.data).toEqual({ n: 3 })
  })

  it('keeps what it has, and does not throw, when a fetch fails', async () => {
    vi.mocked(clientFetch)
      .mockResolvedValueOnce(ok({ n: 1 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
    const { result } = renderHook(() => useLatestJson<{ n: number }>('/api/x'))
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }))

    await act(async () => {
      await result.current.fetch()
      await result.current.fetch()
    })

    expect(result.current.data).toEqual({ n: 1 })
  })
})
