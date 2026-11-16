'use client'

import { FlaskConical } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { IconHint } from '@/components/icon-hint'

/** Marks a feature whose behaviour may still change */
export function ExperimentalMark() {
  const t = useTranslations('search')
  return (
    // Inside a <summary> a click would also fold the section open or shut.
    <span onClick={(e) => e.preventDefault()}>
      <IconHint
        label={t('experimental')}
        hint={t('experimentalHint')}
        icon={<FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />}
        className="text-muted-foreground"
      />
    </span>
  )
}
