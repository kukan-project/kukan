'use client'

import { useLinkStatus } from 'next/link'
import { Loader2 } from 'lucide-react'

/**
 * Spinner inside a `<Link>` while its navigation is pending: click feedback for
 * routes without a `loading.tsx` (see the `(list)` route groups).
 */
export function LinkPendingIndicator() {
  const { pending } = useLinkStatus()
  if (!pending) return null
  return (
    <Loader2
      aria-hidden
      className="ml-2 inline size-4 shrink-0 animate-spin align-middle text-muted-foreground"
    />
  )
}
