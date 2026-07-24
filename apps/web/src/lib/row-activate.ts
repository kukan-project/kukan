import type { KeyboardEvent, MouseEvent } from 'react'
import { cn } from '@kukan/ui'

/** True when the event came from an interactive control nested in the row, which
 *  should handle its own click rather than activating the row. */
function fromNestedControl(target: EventTarget | null): boolean {
  return !!(target as HTMLElement | null)?.closest('a, button, input, select, textarea')
}

/**
 * Props that turn a table row into an activatable control: click, Enter, or
 * Space runs `onActivate`. Events originating from a nested link/button/input
 * are ignored, so those controls don't each need their own stopPropagation.
 *
 * @param onActivate what the row does — e.g. `() => router.push(href)` or opening a dialog.
 * @param opts.role 'link' for row→page navigation (default), 'button' for in-place actions.
 * @param opts.className extra classes merged onto the row (e.g. a disabled/dimmed state).
 */
export function rowActivateProps(
  onActivate: () => void,
  opts: { role?: 'link' | 'button'; className?: string } = {}
) {
  return {
    role: opts.role ?? 'link',
    tabIndex: 0,
    className: cn('cursor-pointer hover:bg-muted/50', opts.className),
    onClick: (e: MouseEvent) => {
      if (!fromNestedControl(e.target)) onActivate()
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (fromNestedControl(e.target)) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onActivate()
      }
    },
  }
}
