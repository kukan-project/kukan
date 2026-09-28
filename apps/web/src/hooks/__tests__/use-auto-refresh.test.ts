import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAutoRefresh } from '../use-auto-refresh'

describe('useAutoRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('polls every 5 seconds, spinning for at least a second each time', async () => {
    const poll = vi.fn(async () => {})
    const { result } = renderHook(() => useAutoRefresh({ poll, reload: vi.fn(async () => {}) }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(poll).toHaveBeenCalledTimes(1)
    expect(result.current.spinning).toBe(true)
    expect(result.current.refreshing).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(result.current.spinning).toBe(false)
  })

  it('never polls without a poll, serving only the button', async () => {
    const reload = vi.fn(async () => {})
    const { result } = renderHook(() => useAutoRefresh({ reload }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
    expect(result.current.spinning).toBe(false)
    expect(reload).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.refresh()
    })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not poll while disabled', async () => {
    const poll = vi.fn(async () => {})
    renderHook(() => useAutoRefresh({ poll, reload: vi.fn(async () => {}), enabled: false }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })

    expect(poll).not.toHaveBeenCalled()
  })

  it('reloads from the button, marking it as refreshing until done', async () => {
    let finish: () => void = () => {}
    const reload = vi.fn(
      () =>
        new Promise<void>((r) => {
          finish = r
        })
    )
    const { result } = renderHook(() => useAutoRefresh({ poll: vi.fn(async () => {}), reload }))

    act(() => {
      result.current.refresh()
    })
    expect(result.current.refreshing).toBe(true)
    expect(result.current.spinning).toBe(true)

    await act(async () => {
      finish()
    })
    expect(result.current.refreshing).toBe(false)
  })

  it('stops spinning, and throws nothing, when a poll or a reload fails', async () => {
    const poll = vi.fn(async () => {
      throw new Error('down')
    })
    const reload = vi.fn(async () => {
      throw new Error('down')
    })
    const { result } = renderHook(() => useAutoRefresh({ poll, reload }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })
    expect(result.current.spinning).toBe(false)

    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.refreshing).toBe(false)
  })
})
