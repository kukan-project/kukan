import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import type { PaginatedResult } from '@kukan/shared'
import { serverFetch } from '@/lib/server-api'
import { getEntity } from '@/lib/catalog-api'
import { entityMetadata } from '@/lib/page-metadata'
import type { DatasetCardItem } from '@/components/dataset/dataset-card'
import { EntityDatasets } from '@/components/dataset/entity-datasets'

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

  // The message catalog does not gate the fetches
  const [entity, dataRes, t] = await Promise.all([
    getEntity('groups', nameOrId),
    serverFetch(`/api/v1/packages?${query}`).catch(() => null),
    getTranslations('category'),
  ])
  if (!entity) notFound()

  let data: PaginatedResult<DatasetCardItem> = { items: [], total: 0, offset, limit }
  if (dataRes?.ok) {
    data = await dataRes.json()
  }

  return (
    <EntityDatasets
      parent={{ href: '/group', label: t('title') }}
      title={entity.title || entity.name}
      description={entity.description}
      basePath={`/group/${nameOrId}`}
      data={data}
      search={{ q, placeholder: t('searchDatasetsPlaceholder') }}
    />
  )
}
