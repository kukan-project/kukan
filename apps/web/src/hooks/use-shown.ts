import { useEffect, useState, type RefObject } from 'react'

/**
 * Whether to run: from when the element is first scrolled to, until a `hidden`
 * ancestor takes its size away. Scrolling away keeps it running, to keep the
 * place in the document.
 */
export function useShown(ref: RefObject<HTMLElement | null>): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const scrolledTo = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setShown(true)
    })
    const hidden = new ResizeObserver(([entry]) => {
      if (!entry?.contentRect.width) setShown(false)
    })
    scrolledTo.observe(el)
    hidden.observe(el)
    return () => {
      scrolledTo.disconnect()
      hidden.disconnect()
    }
  }, [ref])
  return shown
}
