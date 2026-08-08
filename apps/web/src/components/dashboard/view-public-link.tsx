'use client'

import { ExternalLink } from 'lucide-react'
import { Button } from '@kukan/ui'
import { useTranslations } from 'next-intl'

interface ViewPublicLinkProps {
  /** Public page of the entity being managed, e.g. `/dataset/foo` */
  href: string
  variant?: 'ghost' | 'outline'
  size?: 'sm' | 'default'
}

/**
 * Opens the public page of what the dashboard is editing, in its own tab so the
 * editor stays put. A plain `<a>`, not next/link: `target="_blank"` always loads
 * a fresh document, which never reads the router cache, so a Link here would
 * prefetch a payload it can only discard — once per row in a listing.
 */
export function ViewPublicLink({ href, variant = 'ghost', size = 'sm' }: ViewPublicLinkProps) {
  const tc = useTranslations('common')
  return (
    <Button variant={variant} size={size} asChild>
      <a href={href} target="_blank" rel="noopener noreferrer">
        {tc('view')}
        <ExternalLink />
      </a>
    </Button>
  )
}
