'use client'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { PaginatedResult, FacetCounts } from '@kukan/shared'
import { Separator } from '@kukan/ui'
import { clientFetch } from '@/lib/client-api'
import { DatasetCard, type DatasetCardItem } from '@/components/dataset-card'
import { DatasetFilters } from '@/components/search/dataset-filters'
import { DatasetSort } from '@/components/search/dataset-sort'
import { PaginationNav } from '@/components/pagination-nav'
import { SearchForm } from '@/components/search-form'

type DatasetData = PaginatedResult<DatasetCardItem> & { facets?: FacetCounts }

const emptyFacets: FacetCounts = {
  organizations: [],
  groups: [],
  tags: [],
  formats: [],
  licenses: [],
}

interface Props {
  /** SSR-fetched initial data (only when no query and initial page load) */
  initialData: DatasetData | null
}

export function DatasetList({ initialData }: Props) {
  const t = useTranslations()
  const searchParams = useSearchParams()
  const paramsKey = searchParams.toString()

  const q = searchParams.get('q') || ''
  const offset = Number(searchParams.get('offset')) || 0
  const limit = Number(searchParams.get('limit')) || 20
  const currentOrgs = searchParams.getAll('organization')
  const currentGroups = searchParams.getAll('groups')
  const currentTags = searchParams.getAll('tags')
  const currentFormats = searchParams.getAll('res_format')
  const currentLicenses = searchParams.getAll('license_id')
  const sortBy = searchParams.get('sort_by') ?? undefined
  const sortOrder = searchParams.get('sort_order') ?? undefined

  const hasQuery = q.length > 0

  // Track whether this is the very first render with SSR data
  const ssrUsed = useRef(false)
  const isInitialSsr = !ssrUsed.current && !hasQuery && paramsKey === '' && initialData !== null
  if (isInitialSsr) ssrUsed.current = true

  const [data, setData] = useState<DatasetData | null>(isInitialSsr ? initialData : null)
  const [loading, setLoading] = useState(!isInitialSsr)

  const filterParams: Record<string, string | string[] | undefined> = {
    organization: currentOrgs.length ? currentOrgs : undefined,
    groups: currentGroups.length ? currentGroups : undefined,
    tags: currentTags.length ? currentTags : undefined,
    res_format: currentFormats.length ? currentFormats : undefined,
    license_id: currentLicenses.length ? currentLicenses : undefined,
    sort_by: sortBy,
    sort_order: sortOrder,
  }

  // Abort controller to cancel stale requests on rapid param changes
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    // SSR data covers the initial no-query, no-filter case
    if (isInitialSsr) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)

    // Build query string directly from searchParams to avoid stale closures
    const query = new URLSearchParams(searchParams.toString())
    query.set('include_facets', 'true')
    if (!query.has('limit')) query.set('limit', '20')

    clientFetch(`/api/v1/packages?${query}`, { signal: controller.signal })
      .then(async (res) => {
        if (!controller.signal.aborted && res.ok) {
          const result: DatasetData = await res.json()
          setData(result)

          // Lazy-load content highlights after rendering search results
          if (query.get('q')) {
            fetchSnippets(result, query.get('q')!, controller.signal)
          }
        }
      })
      .catch(() => {
        // Aborted or network error
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [paramsKey, isInitialSsr, searchParams])

  /** Fetch content snippets for matched resources and merge into state */
  function fetchSnippets(result: DatasetData, queryText: string, signal: AbortSignal) {
    // Map chunk doc IDs to resource IDs for stable lookup (not positional indices)
    const chunkToResource = new Map<string, string>()
    const chunkIds: string[] = []
    for (const item of result.items) {
      for (const mr of item.matchedResources ?? []) {
        if (mr.matchSource === 'content' && mr._contentDocId) {
          chunkToResource.set(mr._contentDocId, mr.id)
          chunkIds.push(mr._contentDocId)
        }
      }
    }
    if (chunkIds.length === 0) return

    clientFetch('/api/v1/packages/highlights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: queryText, chunks: chunkIds }),
      signal,
    })
      .then(async (res) => {
        if (signal.aborted || !res.ok) return
        const highlights: Record<string, string> = await res.json()

        // Build resourceId → snippet map
        const snippetsByResource = new Map<string, string>()
        for (const [docId, snippet] of Object.entries(highlights)) {
          const resourceId = chunkToResource.get(docId)
          if (resourceId) snippetsByResource.set(resourceId, snippet)
        }
        if (snippetsByResource.size === 0) return

        setData((prev) => {
          if (!prev) return prev
          const updatedItems = [...prev.items]
          let changed = false
          for (const [i, item] of updatedItems.entries()) {
            if (!item.matchedResources?.some((mr) => snippetsByResource.has(mr.id))) continue
            updatedItems[i] = {
              ...item,
              matchedResources: item.matchedResources!.map((mr) => {
                const snippet = snippetsByResource.get(mr.id)
                return snippet ? { ...mr, contentSnippets: [snippet] } : mr
              }),
            }
            changed = true
          }
          return changed ? { ...prev, items: updatedItems } : prev
        })
      })
      .catch(() => {
        // Best-effort: cards still render without snippets
      })
  }

  const facets = data?.facets ?? emptyFacets

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">{t('dataset.title')}</h1>
        <div className="flex items-center gap-4">
          <p className="text-sm text-muted-foreground">
            {loading ? '\u00A0' : t('common.count', { count: data?.total ?? 0 })}
          </p>
          <DatasetSort />
        </div>
      </div>

      <SearchForm action="/dataset" defaultValue={q} hiddenParams={filterParams} />

      <Separator />

      <div className="flex flex-col gap-6 md:flex-row">
        <aside className="w-full shrink-0 md:w-64">
          <DatasetFilters
            query={q}
            currentOrgs={currentOrgs}
            currentGroups={currentGroups}
            currentTags={currentTags}
            currentFormats={currentFormats}
            currentLicenses={currentLicenses}
            facets={facets}
            sortBy={sortBy}
            sortOrder={sortOrder}
          />
        </aside>

        <div className="min-w-0 flex-1">
          {loading ? (
            <div className="flex flex-col gap-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-32 animate-pulse rounded-lg border bg-muted/30" />
              ))}
            </div>
          ) : !data || data.items.length === 0 ? (
            <p className="py-12 text-center text-muted-foreground">
              {q ? t('dataset.noMatchingDatasets', { query: q }) : t('dataset.noDatasets')}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {data.items.map((pkg) => (
                <DatasetCard key={pkg.id} pkg={pkg} />
              ))}
            </div>
          )}

          {data && data.total > 0 && (
            <div className="mt-6">
              <PaginationNav
                basePath="/dataset"
                params={{ q: q || undefined, ...filterParams }}
                offset={offset}
                limit={limit}
                total={data.total}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
