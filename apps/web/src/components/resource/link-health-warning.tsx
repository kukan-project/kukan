'use client'

import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@kukan/ui'

interface LinkHealthWarningProps {
  message: string
}

/**
 * Why a link may no longer work, behind an icon.
 *
 * A popover rather than a `title` tooltip: a tooltip needs a pointer to hover
 * with, and a phone has none — the explanation would be unreachable exactly
 * where the icon is smallest.
 */
export function LinkHealthWarning({ message }: LinkHealthWarningProps) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={message}
          className="ml-1 flex shrink-0 cursor-pointer items-center rounded p-1 text-warning-tint-foreground"
          // Only a mouse hovers. A tap fires enter before click, so opening on
          // it would leave the click toggling the popover straight back shut.
          onPointerEnter={(e) => e.pointerType === 'mouse' && setOpen(true)}
          onPointerLeave={(e) => e.pointerType === 'mouse' && setOpen(false)}
          // Keyboard focus only: a pointer press focuses the button too, and
          // opening there would leave the click Radix handles toggling it shut.
          onFocus={(e) => e.currentTarget.matches(':focus-visible') && setOpen(true)}
          onBlur={() => setOpen(false)}
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-64 text-sm font-normal text-foreground"
        // Hover and focus open this as well, and taking focus on either would
        // move the reader off what they were on. Nothing took focus, so nothing
        // is restored on close either — the default sends it back to the
        // trigger, which reads as a fresh focus and reopens what just closed.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {message}
      </PopoverContent>
    </Popover>
  )
}
