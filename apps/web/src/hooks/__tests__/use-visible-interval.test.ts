import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useVisibleInterval } from '../use-visible-interval'

let visibility: DocumentVisibilityState = 'visible'

function setVisibility(state: DocumentVisibilityState) {
  visibility = state
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useVisibleInterval', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    visibility = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('calls back every interval while the tab is visible', async () => {
    const callback = vi.fn()
    renderHook(() => useVisibleInterval(callback, 1000))

    await vi.advanceTimersByTimeAsync(3000)

    expect(callback).toHaveBeenCalledTimes(3)
  })

  it('waits for a slow call to settle before counting the next interval', async () => {
    let settle: () => void = () => {}
    const callback = vi.fn(
      () =>
        new Promise<void>((r) => {
          settle = r
        })
    )
    renderHook(() => useVisibleInterval(callback, 1000))

    await vi.advanceTimersByTimeAsync(5000)
    expect(callback).toHaveBeenCalledTimes(1)

    settle()
    await vi.advanceTimersByTimeAsync(1000)
    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('stops while hidden, and calls back at once when shown again', async () => {
    const callback = vi.fn()
    renderHook(() => useVisibleInterval(callback, 1000))

    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(5000)
    expect(callback).not.toHaveBeenCalled()

    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(callback).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('schedules nothing from a call that settles after the tab was hidden', async () => {
    let settle: () => void = () => {}
    const callback = vi.fn(
      () =>
        new Promise<void>((r) => {
          settle = r
        })
    )
    renderHook(() => useVisibleInterval(callback, 1000))
    await vi.advanceTimersByTimeAsync(1000)

    setVisibility('hidden')
    settle()
    await vi.advanceTimersByTimeAsync(5000)

    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('waits for a call still out when the tab comes back, instead of starting another', async () => {
    let settle: () => void = () => {}
    const callback = vi.fn(
      () =>
        new Promise<void>((r) => {
          settle = r
        })
    )
    renderHook(() => useVisibleInterval(callback, 1000))
    await vi.advanceTimersByTimeAsync(1000)
    expect(callback).toHaveBeenCalledTimes(1)

    setVisibility('hidden')
    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(5000)
    expect(callback).toHaveBeenCalledTimes(1)

    settle()
    await vi.advanceTimersByTimeAsync(1000)
    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('waits for a call still out when it is enabled again', async () => {
    let settle: () => void = () => {}
    const callback = vi.fn(
      () =>
        new Promise<void>((r) => {
          settle = r
        })
    )
    const { rerender } = renderHook(({ enabled }) => useVisibleInterval(callback, 1000, enabled), {
      initialProps: { enabled: true },
    })
    await vi.advanceTimersByTimeAsync(1000)

    rerender({ enabled: false })
    rerender({ enabled: true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(callback).toHaveBeenCalledTimes(1)

    settle()
    await vi.advanceTimersByTimeAsync(1000)
    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('does not start in a tab opened in the background', async () => {
    visibility = 'hidden'
    const callback = vi.fn()
    renderHook(() => useVisibleInterval(callback, 1000))

    await vi.advanceTimersByTimeAsync(5000)

    expect(callback).not.toHaveBeenCalled()
  })

  it('pauses while disabled', async () => {
    const callback = vi.fn()
    const { rerender } = renderHook(({ enabled }) => useVisibleInterval(callback, 1000, enabled), {
      initialProps: { enabled: false },
    })

    await vi.advanceTimersByTimeAsync(5000)
    setVisibility('hidden')
    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(callback).not.toHaveBeenCalled()

    rerender({ enabled: true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('calls the latest callback without restarting the timer', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(({ cb }) => useVisibleInterval(cb, 1000), {
      initialProps: { cb: first },
    })

    await vi.advanceTimersByTimeAsync(600)
    rerender({ cb: second })
    await vi.advanceTimersByTimeAsync(400)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('stops on unmount', async () => {
    const callback = vi.fn()
    const { unmount } = renderHook(() => useVisibleInterval(callback, 1000))

    unmount()
    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(5000)

    expect(callback).not.toHaveBeenCalled()
  })
})
