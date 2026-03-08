import Link from 'next/link'
import { Card, CardContent, Separator } from '@kukan/ui'
import type { PaginatedResult } from '@kukan/shared'
import { serverFetch } from '@/lib/api'
import { SearchForm } from '@/components/search-form'
import { PaginationNav } from '@/components/pagination-nav'
import { EntityImage } from '@/components/entity-image'

interface Organization {
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

export default async function OrganizationsPage({ searchParams }: Props) {
  const params = await searchParams
  const q = params.q || ''
  const offset = Number(params.offset) || 0
  const limit = Number(params.limit) || 20

  const query = new URLSearchParams()
  if (q) query.set('q', q)
  query.set('offset', String(offset))
  query.set('limit', String(limit))

  let data: PaginatedResult<Organization> = { items: [], total: 0, offset: 0, limit: 20 }
  try {
    const res = await serverFetch(`/api/v1/organizations?${query}`)
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
          <h1 className="text-2xl font-bold tracking-tight">組織</h1>
          <p className="text-sm text-muted-foreground">{data.total} 件</p>
        </div>

        <SearchForm action="/organization" defaultValue={q} placeholder="組織を検索..." />

        <Separator />

        {data.items.length === 0 ? (
          <p className="py-12 text-center text-muted-foreground">
            {q ? `「${q}」に一致する組織はありません` : '組織がありません'}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {data.items.map((org) => (
              <Link key={org.id} href={`/organization/${org.name}`}>
                <Card className="h-full transition-colors hover:bg-accent/50">
                  <CardContent className="flex flex-col items-center gap-3 px-4 py-6 text-center">
                    <EntityImage imageUrl={org.imageUrl} name={org.title || org.name} />
                    <div className="min-w-0">
                      <p className="font-semibold">{org.title || org.name}</p>
                      {org.description && (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {org.description}
                        </p>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{org.datasetCount} データセット</p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}

        <PaginationNav
          basePath="/organization"
          params={{ q: q || undefined }}
          offset={offset}
          limit={limit}
          total={data.total}
        />
      </div>
    </div>
  )
}
