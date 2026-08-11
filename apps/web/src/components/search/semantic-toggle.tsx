'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { SwitchField } from '@/components/switch-field'

/** Hybrid-search toggle — semantic=false in the URL disables the vector leg (ADR-034).
 *  `semanticEnabled` comes from the caller's site-settings fetch; an explicit
 *  false (semantic search unavailable or switched off site-wide, ADR-036) hides it. */
export function SemanticToggle({ semanticEnabled }: { semanticEnabled: boolean | null }) {
  const t = useTranslations('search')
  const router = useRouter()
  const searchParams = useSearchParams()

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
    <SwitchField
      label={t('semanticToggle')}
      labelClassName="text-muted-foreground"
      checked={enabled}
      onCheckedChange={handleChange}
    />
  )
}
