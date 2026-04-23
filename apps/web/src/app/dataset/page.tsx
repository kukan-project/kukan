import { Suspense } from 'react'
import type { PaginatedResult, FacetCounts } from '@kukan/shared'
import { serverFetch } from '@/lib/server-api'
import { toArray } from '@/lib/query'
import type { DatasetCardItem } from '@/components/dataset-card'
import { DatasetList } from '@/components/search/dataset-list'

interface Props {
  searchParams: Promise<{
    q?: string
    offset?: string
    limit?: string
    organization?: string | string[]
    groups?: string | string[]
    tags?: string | string[]
    res_format?: string | string[]
    license_id?: string | string[]
    sort_by?: string
    sort_order?: string
  }>
}

type DatasetData = PaginatedResult<DatasetCardItem> & { facets?: FacetCounts }

export default async function DatasetsPage({ searchParams }: Props) {
  const params = await searchParams
  const q = params.q || ''

  // SSR: fetch initial data only when no query (listing page, SEO-relevant)
  // With query: DatasetList fetches client-side (avoids OpenSearch blocking SSR)
  let initialData: DatasetData | null = null

  if (!q) {
    try {
      const query = new URLSearchParams()
      query.set('offset', String(Number(params.offset) || 0))
      query.set('limit', String(Number(params.limit) || 20))
      const filterKeys = ['organization', 'groups', 'tags', 'res_format', 'license_id'] as const
      for (const key of filterKeys) {
        for (const v of toArray(params[key])) query.append(key, v)
      }
      query.set('include_facets', 'true')
      if (params.sort_by) query.set('sort_by', params.sort_by)
      if (params.sort_order) query.set('sort_order', params.sort_order)

      const res = await serverFetch(`/api/v1/packages?${query}`)
      if (res.ok) initialData = await res.json()
    } catch {
      // API unavailable
    }
  }

  return (
    <div className="mx-auto max-w-[var(--kukan-container-max-width)] px-4 py-8">
      <Suspense>
        <DatasetList initialData={initialData} />
      </Suspense>
    </div>
  )
}
