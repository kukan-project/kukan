import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Separator } from '@kukan/ui'
import type { PaginatedResult } from '@kukan/shared'
import { serverFetch } from '@/lib/server-api'
import { SearchForm } from '@/components/search-form'
import { DatasetCard, type DatasetCardItem } from '@/components/dataset-card'
import { PaginationNav } from '@/components/pagination-nav'

interface Props {
  params: Promise<{ nameOrId: string }>
  searchParams: Promise<{ q?: string; offset?: string; limit?: string }>
}

export default async function OrganizationDatasetsPage({ params, searchParams }: Props) {
  const [{ nameOrId }, sp, t, tc] = await Promise.all([
    params,
    searchParams,
    getTranslations('organization'),
    getTranslations('common'),
  ])
  const q = sp.q || ''
  const offset = Number(sp.offset) || 0
  const limit = Number(sp.limit) || 20

  const query = new URLSearchParams()
  if (q) query.set('q', q)
  query.set('owner_org', nameOrId)
  query.set('offset', String(offset))
  query.set('limit', String(limit))

  const [orgRes, dataRes] = await Promise.all([
    serverFetch(`/api/v1/organizations/${encodeURIComponent(nameOrId)}`).catch(() => null),
    serverFetch(`/api/v1/packages?${query}`).catch(() => null),
  ])

  const org = orgRes?.ok ? await orgRes.json() : null
  let data: PaginatedResult<DatasetCardItem> = { items: [], total: 0, offset: 0, limit: 20 }
  if (dataRes?.ok) {
    data = await dataRes.json()
  }

  const orgTitle = org?.title || org?.name || nameOrId

  return (
    <div className="mx-auto max-w-[var(--kukan-container-max-width)] px-4 py-8">
      <div className="flex flex-col gap-6">
        <nav className="text-sm text-muted-foreground">
          <Link href="/organization" className="hover:text-foreground">
            {t('title')}
          </Link>
          <span className="mx-2">/</span>
          <span className="text-foreground">{orgTitle}</span>
        </nav>

        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">{orgTitle}</h1>
          <p className="text-sm text-muted-foreground">
            {tc('datasetCount', { count: data.total })}
          </p>
        </div>

        {org?.description && <p className="text-sm text-muted-foreground">{org.description}</p>}

        <SearchForm
          action={`/organization/${nameOrId}`}
          defaultValue={q}
          placeholder={t('searchDatasetsPlaceholder')}
        />

        <Separator />

        {data.items.length === 0 ? (
          <p className="py-12 text-center text-muted-foreground">{tc('noResults')}</p>
        ) : (
          <div className="flex flex-col gap-4">
            {data.items.map((pkg) => (
              <DatasetCard key={pkg.id} pkg={pkg} />
            ))}
          </div>
        )}

        <PaginationNav
          basePath={`/organization/${nameOrId}`}
          params={{ q: q || undefined }}
          offset={offset}
          limit={limit}
          total={data.total}
        />
      </div>
    </div>
  )
}
