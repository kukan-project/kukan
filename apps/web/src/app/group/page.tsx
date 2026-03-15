import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Card, CardContent, Separator } from '@kukan/ui'
import type { PaginatedResult } from '@kukan/shared'
import { serverFetch } from '@/lib/server-api'
import { SearchForm } from '@/components/search-form'
import { PaginationNav } from '@/components/pagination-nav'
import { EntityImage } from '@/components/entity-image'

interface Group {
  id: string
  name: string
  title?: string | null
  description?: string | null
  imageUrl?: string | null
  datasetCount: number
}

interface Props {
  searchParams: Promise<{ q?: string; offset?: string; limit?: string }>
}

export default async function GroupsPage({ searchParams }: Props) {
  const [params, t] = await Promise.all([searchParams, getTranslations('group')])
  const tc = await getTranslations('common')
  const q = params.q || ''
  const offset = Number(params.offset) || 0
  const limit = Number(params.limit) || 20

  const query = new URLSearchParams()
  if (q) query.set('q', q)
  query.set('offset', String(offset))
  query.set('limit', String(limit))

  let data: PaginatedResult<Group> = { items: [], total: 0, offset: 0, limit: 20 }
  try {
    const res = await serverFetch(`/api/v1/groups?${query}`)
    if (res.ok) {
      data = await res.json()
    }
  } catch {
    // API unavailable
  }

  return (
    <div className="mx-auto max-w-[var(--kukan-container-max-width)] px-4 py-8">
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{tc('count', { count: data.total })}</p>
        </div>

        <SearchForm action="/group" defaultValue={q} placeholder={t('searchPlaceholder')} />

        <Separator />

        {data.items.length === 0 ? (
          <p className="py-12 text-center text-muted-foreground">
            {q ? t('noMatchingGroups', { query: q }) : t('noGroups')}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {data.items.map((grp) => (
              <Link key={grp.id} href={`/group/${grp.name}`}>
                <Card className="h-full transition-colors hover:bg-accent/50">
                  <CardContent className="flex flex-col items-center gap-3 px-4 py-6 text-center">
                    <EntityImage imageUrl={grp.imageUrl} name={grp.title || grp.name} />
                    <div className="min-w-0">
                      <p className="font-semibold">{grp.title || grp.name}</p>
                      {grp.description && (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {grp.description}
                        </p>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t('datasetCount', { count: grp.datasetCount })}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}

        <PaginationNav
          basePath="/group"
          params={{ q: q || undefined }}
          offset={offset}
          limit={limit}
          total={data.total}
        />
      </div>
    </div>
  )
}
