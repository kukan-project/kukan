'use client'

import { useTranslations } from 'next-intl'
import { NewTabLink } from '@/components/new-tab-link'

interface ViewPublicLinkProps {
  /** Public page of the entity being managed, e.g. `/dataset/foo` */
  href: string
  variant?: 'ghost' | 'outline'
  size?: 'sm' | 'default'
}

/** The dashboard's way to the public page of what it is editing. */
export function ViewPublicLink({ href, variant = 'ghost', size = 'sm' }: ViewPublicLinkProps) {
  const tc = useTranslations('common')
  return <NewTabLink href={href} label={tc('view')} variant={variant} size={size} />
}
