'use client'

import { useId } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Label, Switch } from '@kukan/ui'

/** Hybrid-search toggle — semantic=false in the URL disables the vector leg (ADR-034).
 *  `semanticEnabled` comes from the caller's site-settings fetch; an explicit
 *  false (semantic search unavailable or switched off site-wide, ADR-036) hides it. */
export function SemanticToggle({ semanticEnabled }: { semanticEnabled: boolean | null }) {
  const t = useTranslations('search')
  const router = useRouter()
  const searchParams = useSearchParams()
  const id = useId()

  const hasQuery = !!searchParams.get('q')?.trim()
  if (!hasQuery || semanticEnabled === false) return null

  const enabled = searchParams.get('semantic') !== 'false'

  const handleChange = (checked: boolean) => {
    const params = new URLSearchParams(searchParams.toString())
    params.delete('offset')
    if (checked) {
      params.delete('semantic')
    } else {
      params.set('semantic', 'false')
    }
    router.push(`/dataset?${params.toString()}`)
  }

  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={enabled} onCheckedChange={handleChange} />
      <Label htmlFor={id} className="text-sm font-normal text-muted-foreground">
        {t('semanticToggle')}
      </Label>
    </div>
  )
}
