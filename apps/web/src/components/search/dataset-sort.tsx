'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kukan/ui'

/** Composite value encoding sort_by + sort_order */
const SORT_OPTIONS = [
  { value: 'updated:desc', sortBy: 'updated', sortOrder: 'desc' },
  { value: 'updated:asc', sortBy: 'updated', sortOrder: 'asc' },
  { value: 'created:desc', sortBy: 'created', sortOrder: 'desc' },
  { value: 'created:asc', sortBy: 'created', sortOrder: 'asc' },
  { value: 'name:asc', sortBy: 'name', sortOrder: 'asc' },
  { value: 'name:desc', sortBy: 'name', sortOrder: 'desc' },
] as const

/** Special value representing relevance sort (no explicit sort params) */
const RELEVANCE_VALUE = '_relevance'

export function DatasetSort() {
  const t = useTranslations('search')
  const router = useRouter()
  const searchParams = useSearchParams()

  const hasQuery = !!searchParams.get('q')?.trim()
  const sortByParam = searchParams.get('sort_by')
  const sortOrderParam = searchParams.get('sort_order')
  const isExplicit = sortByParam !== null

  // When no explicit sort: relevance if query, updated:desc if browse
  const currentValue = isExplicit
    ? `${sortByParam}:${sortOrderParam ?? 'desc'}`
    : hasQuery
      ? RELEVANCE_VALUE
      : 'updated:desc'

  const handleChange = (value: string) => {
    const params = new URLSearchParams(searchParams.toString())
    // Reset offset when sort changes
    params.delete('offset')

    if (value === RELEVANCE_VALUE) {
      params.delete('sort_by')
      params.delete('sort_order')
    } else {
      const option = SORT_OPTIONS.find((o) => o.value === value)
      if (!option) return
      params.set('sort_by', option.sortBy)
      params.set('sort_order', option.sortOrder)
    }

    router.push(`/dataset?${params.toString()}`)
  }

  return (
    <Select value={currentValue} onValueChange={handleChange}>
      <SelectTrigger className="w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {hasQuery && <SelectItem value={RELEVANCE_VALUE}>{t('sort.relevance')}</SelectItem>}
        {SORT_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {t(`sort.${option.value.replace(':', '_')}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
