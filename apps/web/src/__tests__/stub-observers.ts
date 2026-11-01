import { vi } from 'vitest'

/**
 * The observers a preview waits on (useShown), which happy-dom does not drive: by
 * default scrolled to and laid out. `hide` and `show` are what a tab switch does.
 */
export function stubObservers({
  scrolledTo = true,
  width = 800,
}: { scrolledTo?: boolean; width?: number } = {}) {
  const intersecting: ((entries: { isIntersecting: boolean }[]) => void)[] = []
  const resizing: ((entries: { contentRect: { width: number } }[]) => void)[] = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private callback: (typeof intersecting)[number]) {
        intersecting.push(callback)
      }
      observe() {
        this.callback([{ isIntersecting: scrolledTo }])
      }
      disconnect() {}
    }
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: (typeof resizing)[number]) {
        resizing.push(callback)
      }
      observe() {
        this.callback([{ contentRect: { width } }])
      }
      disconnect() {}
    }
  )
  return {
    hide: () => resizing.forEach((notify) => notify([{ contentRect: { width: 0 } }])),
    show: () => intersecting.forEach((notify) => notify([{ isIntersecting: true }])),
  }
}
