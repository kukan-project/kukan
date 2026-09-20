'use client'

import { ExternalLink } from 'lucide-react'
import { Button } from '@kukan/ui'

interface NewTabLinkProps {
  href: string
  label: string
  variant?: 'ghost' | 'outline'
  size?: 'sm' | 'default'
}

/**
 * Opens a counterpart page — the public page of what is being edited, the
 * dashboard row of what is being viewed — in its own tab, so the page it was
 * opened from stays put. A plain `<a>`, not next/link: `target="_blank"`
 * always loads a fresh document, which never reads the router cache, so a Link
 * here would prefetch a payload it can only discard — once per row in a
 * listing.
 */
export function NewTabLink({ href, label, variant = 'ghost', size = 'sm' }: NewTabLinkProps) {
  return (
    <Button variant={variant} size={size} asChild>
      <a href={href} target="_blank" rel="noopener noreferrer">
        {label}
        <ExternalLink />
      </a>
    </Button>
  )
}
