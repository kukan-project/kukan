import type { PaginatedResult, FacetCounts } from '@kukan/shared'
import { getTranslations } from 'next-intl/server'
import { Separator } from '@kukan/ui'
import { serverFetch } from '@/lib/server-api'
import { SearchForm } from '@/components/search-form'
import { DatasetCard, type DatasetCardItem } from '@/components/dataset-card'
import { DatasetFilters } from '@/components/search/dataset-filters'
import { PaginationNav } from '@/components/pagination-nav'

interface Props {
  searchParams: Promise<{
    q?: string
    offset?: string
    limit?: string
    owner_org?: string
    group?: string
    tags?: string
    formats?: string
  }>
}

const emptyFacets: FacetCounts = {
  organizations: [],
  groups: [],
  tags: [],
  formats: [],
}

export default async function DatasetsPage({ searchParams }: Props) {
  const [params, t] = await Promise.all([searchParams, getTranslations()])
  const q = params.q || ''
  const offset = Number(params.offset) || 0
  const limit = Number(params.limit) || 20
  const ownerOrg = params.owner_org || ''
  const group = params.group || ''
  const currentTags = params.tags ? params.tags.split(',').filter(Boolean) : []
  const formats = params.formats || ''

  const query = new URLSearchParams()
  if (q) query.set('q', q)
  query.set('offset', String(offset))
  query.set('limit', String(limit))
  if (ownerOrg) query.set('owner_org', ownerOrg)
  if (group) query.set('group', group)
  if (currentTags.length > 0) query.set('tags', currentTags.join(','))
  if (formats) query.set('formats', formats)
  query.set('include_facets', 'true')

  let data: PaginatedResult<DatasetCardItem> & { facets?: FacetCounts } = {
    items: [],
    total: 0,
    offset: 0,
    limit: 20,
  }

  try {
    const res = await serverFetch(`/api/v1/packages?${query}`)
    if (res.ok) {
      data = await res.json()
    }
  } catch {
    // API unavailable (e.g. during build)
  }

  const facets = data.facets ?? emptyFacets

  return (
    <div className="mx-auto max-w-[var(--kukan-container-max-width)] px-4 py-8">
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">{t('dataset.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('common.count', { count: data.total })}
          </p>
        </div>

        <SearchForm
          action="/dataset"
          defaultValue={q}
          hiddenParams={{
            owner_org: ownerOrg || undefined,
            group: group || undefined,
            tags: currentTags.join(',') || undefined,
            formats: formats || undefined,
          }}
        />

        <Separator />

        <div className="flex flex-col gap-6 md:flex-row">
          {/* Filter sidebar */}
          <aside className="w-full shrink-0 md:w-56">
            <DatasetFilters
              query={q}
              currentOrg={ownerOrg || undefined}
              currentGroup={group || undefined}
              currentTags={currentTags}
              currentFormat={formats || undefined}
              facets={facets}
            />
          </aside>

          {/* Dataset list */}
          <div className="min-w-0 flex-1">
            {data.items.length === 0 ? (
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

            <div className="mt-6">
              <PaginationNav
                basePath="/dataset"
                params={{
                  q: q || undefined,
                  owner_org: ownerOrg || undefined,
                  group: group || undefined,
                  tags: currentTags.join(',') || undefined,
                  formats: formats || undefined,
                }}
                offset={offset}
                limit={limit}
                total={data.total}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
