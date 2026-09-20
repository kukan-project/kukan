'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { SwitchField } from '@/components/switch-field'

/** Hybrid-search toggle — semantic=false in the URL disables the vector leg (ADR-034).
 *  Flipping it re-runs the search on screen, so it belongs to a search: with no
 *  query there is nothing to re-run, and the slot stays empty.
 *  `semanticEnabled` comes from the caller's site-settings fetch; an explicit
 *  false (semantic search unavailable or switched off site-wide, ADR-036) hides it.
 *  `degraded` says the last search answered by keyword alone with the leg asked
 *  for, and takes the switch's place — turning it on is not what is missing. */
export function SemanticToggle({
  semanticEnabled,
  degraded,
}: {
  semanticEnabled: boolean | null
  degraded?: boolean
}) {
  const t = useTranslations('search')
  const router = useRouter()
  const searchParams = useSearchParams()

  const hasQuery = !!searchParams.get('q')?.trim()
  if (!hasQuery || semanticEnabled === false) return null

  if (degraded) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t('semanticUnavailable')}
      </p>
    )
  }

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
