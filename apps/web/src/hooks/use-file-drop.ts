import { useRef, useState } from 'react'

interface UseFileDropOptions {
  /** Receives the dropped files (never called with an empty list) */
  onFiles: (files: File[]) => void
  disabled?: boolean
}

/**
 * Drag-and-drop file target with nested enter/leave depth tracking. Spread
 * `handlers` on the target element; `active` is true while a file drag is
 * over it. File drags always claim the default action — an unhandled drop
 * would navigate the browser to the local file — `disabled` only turns off
 * the highlight and the onFiles delivery. Drops already claimed by an inner
 * zone (defaultPrevented) are ignored.
 */
export function useFileDrop({ onFiles, disabled }: UseFileDropOptions) {
  const [active, setActive] = useState(false)
  const depth = useRef(0)

  const handlers = {
    onDragEnter(e: React.DragEvent) {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      if (disabled) return
      depth.current += 1
      // Only the outermost entry updates state — inner boundary crossings
      // would re-render the owner on every element the drag passes over
      if (depth.current === 1) setActive(true)
    },
    onDragOver(e: React.DragEvent) {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
    },
    onDragLeave() {
      if (depth.current > 0) depth.current -= 1
      if (depth.current === 0) setActive(false)
    },
    onDrop(e: React.DragEvent) {
      depth.current = 0
      setActive(false)
      if (e.defaultPrevented) return
      if (e.dataTransfer.files.length === 0) return
      e.preventDefault()
      if (disabled) return
      onFiles(Array.from(e.dataTransfer.files))
    },
  }

  return { active, handlers }
}
