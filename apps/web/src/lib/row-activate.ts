import type { KeyboardEvent, MouseEvent } from 'react'
import { cn } from '@kukan/ui'

/** True when the event came from an interactive control nested in the row, which
 *  should handle its own click rather than activating the row. */
function fromNestedControl(target: EventTarget | null): boolean {
  return !!(target as HTMLElement | null)?.closest('a, button, input, select, textarea')
}

const ACTIVATABLE_CLASS = 'cursor-pointer hover:bg-muted/50'

/**
 * Props that turn a table row into an activatable control: click, Enter, or
 * Space runs `onActivate`. Events originating from a nested link/button/input
 * are ignored, so those controls don't each need their own stopPropagation.
 *
 * @param onActivate what the row does — e.g. `() => router.push(href)` or opening a dialog.
 * @param opts.role 'link' for row→page navigation (default), 'button' for in-place actions.
 * @param opts.className extra classes merged onto the row (e.g. a disabled/dimmed state).
 * @param opts.disabled the row keeps its role but stops responding and leaves the
 *        tab order — for rows that are only temporarily inert (a pending save, say),
 *        where dropping the affordance entirely would make the table jump.
 */
export function rowActivateProps(
  onActivate: () => void,
  opts: { role?: 'link' | 'button'; className?: string; disabled?: boolean } = {}
) {
  const activate = (e: MouseEvent | KeyboardEvent) => {
    if (opts.disabled || fromNestedControl(e.target)) return false
    onActivate()
    return true
  }
  const base = opts.disabled ? undefined : ACTIVATABLE_CLASS
  return {
    role: opts.role ?? 'link',
    tabIndex: opts.disabled ? undefined : 0,
    'aria-disabled': opts.disabled || undefined,
    className: opts.className ? cn(base, opts.className) : base,
    onClick: (e: MouseEvent) => {
      activate(e)
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      if (activate(e)) e.preventDefault()
    },
  }
}
