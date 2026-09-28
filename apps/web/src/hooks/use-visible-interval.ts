import { useEffect, useRef } from 'react'

/**
 * Calls `callback` `intervalMs` after the last call settled, while the tab is
 * visible, and once right away when it comes back — a tab left open behind
 * others sends nothing, and a call never overlaps another: coming back while
 * one is still out waits for it instead. `enabled: false` pauses it (a dialog
 * open, say).
 */
export function useVisibleInterval(callback: () => unknown, intervalMs: number, enabled = true) {
  // The latest callback, so a new closure every render does not restart the timer
  const saved = useRef(callback)
  useEffect(() => {
    saved.current = callback
  }, [callback])

  // Outlive a restart of the effect below, so a call from before it still
  // holds off the next one and hands over when it settles
  const busy = useRef(false)
  const onSettled = useRef<() => void>(() => {})

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let active = false
    const schedule = (delay: number) => {
      clearTimeout(timer)
      timer = setTimeout(async () => {
        busy.current = true
        try {
          await saved.current()
        } finally {
          busy.current = false
          onSettled.current()
        }
      }, delay)
    }
    onSettled.current = () => {
      if (active) schedule(intervalMs)
    }
    const start = (delay: number) => {
      active = true
      if (!busy.current) schedule(delay)
    }
    const stop = () => {
      active = false
      clearTimeout(timer)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') start(0)
      else stop()
    }
    if (document.visibilityState === 'visible') start(intervalMs)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [intervalMs, enabled])
}
