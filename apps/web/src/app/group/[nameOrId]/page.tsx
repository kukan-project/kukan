import Link from 'next/link'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Separator } from '@kukan/ui'
import type { PaginatedResult } from '@kukan/shared'
import { serverFetch } from '@/lib/server-api'
import { getEntity } from '@/lib/catalog-api'
import { entityMetadata } from '@/lib/page-metadata'
import { SearchForm } from '@/components/search-form'
import { DatasetCard, type DatasetCardItem } from '@/components/dataset-card'
import { PaginationNav } from '@/components/pagination-nav'

interface Props {
  params: Promise<{ nameOrId: string }>
  searchParams: Promise<{ q?: string; offset?: string; limit?: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { nameOrId } = await params
  return entityMetadata(await getEntity('groups', nameOrId))
}

export default async function GroupDatasetsPage({ params, searchParams }: Props) {
  const [{ nameOrId }, sp] = await Promise.all([params, searchParams])
  const q = sp.q || ''
  const offset = Number(sp.offset) || 0
  const limit = Number(sp.limit) || 20

  const query = new URLSearchParams()
  if (q) query.set('q', q)
  query.set('groups', nameOrId)
  query.set('offset', String(offset))
  query.set('limit', String(limit))

  // The message catalogs do not gate the fetches
  const [grp, dataRes, t, tc] = await Promise.all([
    getEntity('groups', nameOrId),
    serverFetch(`/api/v1/packages?${query}`).catch(() => null),
    getTranslations('category'),
    getTranslations('common'),
  ])

  let data: PaginatedResult<DatasetCardItem> = { items: [], total: 0, offset: 0, limit: 20 }
  if (dataRes?.ok) {
    data = await dataRes.json()
  }

  const groupTitle = grp?.title || grp?.name || nameOrId

  return (
    <div className="mx-auto max-w-[var(--kukan-container-max-width)] px-4 py-8">
      <div className="flex flex-col gap-6">
        <nav className="text-sm text-muted-foreground">
          <Link href="/group" className="hover:text-foreground">
            {t('title')}
          </Link>
          <span className="mx-2">/</span>
          <span className="text-foreground">{groupTitle}</span>
        </nav>

        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">{groupTitle}</h1>
          <p className="text-sm text-muted-foreground">
            {tc('datasetCount', { count: data.total })}
          </p>
        </div>

        {grp?.description && <p className="text-sm text-muted-foreground">{grp.description}</p>}

        <SearchForm
          action={`/group/${nameOrId}`}
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
          basePath={`/group/${nameOrId}`}
          params={{ q: q || undefined }}
          offset={offset}
          limit={limit}
          total={data.total}
        />
      </div>
    </div>
  )
}
