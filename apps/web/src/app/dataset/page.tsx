import type { PaginatedResult, FacetCounts } from '@kukan/shared'
import { getTranslations } from 'next-intl/server'
import { Separator } from '@kukan/ui'
import { serverFetch } from '@/lib/server-api'
import { toArray } from '@/lib/query'
import { SearchForm } from '@/components/search-form'
import { DatasetCard, type DatasetCardItem } from '@/components/dataset-card'
import { DatasetFilters } from '@/components/search/dataset-filters'
import { PaginationNav } from '@/components/pagination-nav'

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
  }>
}

const emptyFacets: FacetCounts = {
  organizations: [],
  groups: [],
  tags: [],
  formats: [],
  licenses: [],
}

export default async function DatasetsPage({ searchParams }: Props) {
  const [params, t] = await Promise.all([searchParams, getTranslations()])
  const q = params.q || ''
  const offset = Number(params.offset) || 0
  const limit = Number(params.limit) || 20
  const currentOrgs = toArray(params.organization)
  const currentGroups = toArray(params.groups)
  const currentTags = toArray(params.tags)
  const currentFormats = toArray(params.res_format)
  const currentLicenses = toArray(params.license_id)

  // Filter params as arrays (repeated params for URL, hidden fields, and API query)
  const filterParams: Record<string, string[] | undefined> = {
    organization: currentOrgs.length ? currentOrgs : undefined,
    groups: currentGroups.length ? currentGroups : undefined,
    tags: currentTags.length ? currentTags : undefined,
    res_format: currentFormats.length ? currentFormats : undefined,
    license_id: currentLicenses.length ? currentLicenses : undefined,
  }

  const query = new URLSearchParams()
  if (q) query.set('q', q)
  query.set('offset', String(offset))
  query.set('limit', String(limit))
  for (const [key, values] of Object.entries(filterParams)) {
    if (values) for (const v of values) query.append(key, v)
  }
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

        <SearchForm action="/dataset" defaultValue={q} hiddenParams={filterParams} />

        <Separator />

        <div className="flex flex-col gap-6 md:flex-row">
          {/* Filter sidebar */}
          <aside className="w-full shrink-0 md:w-64">
            <DatasetFilters
              query={q}
              currentOrgs={currentOrgs}
              currentGroups={currentGroups}
              currentTags={currentTags}
              currentFormats={currentFormats}
              currentLicenses={currentLicenses}
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
                params={{ q: q || undefined, ...filterParams }}
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
