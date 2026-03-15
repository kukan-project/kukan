import type { PaginatedResult } from '@kukan/shared'
import { Separator } from '@kukan/ui'
import { serverFetch } from '@/lib/server-api'
import { SearchForm } from '@/components/search-form'
import { DatasetCard, type DatasetCardItem } from '@/components/dataset-card'
import { PaginationNav } from '@/components/pagination-nav'

interface Props {
  searchParams: Promise<{ q?: string; offset?: string; limit?: string }>
}

export default async function DatasetsPage({ searchParams }: Props) {
  const params = await searchParams
  const q = params.q || ''
  const offset = Number(params.offset) || 0
  const limit = Number(params.limit) || 20

  const query = new URLSearchParams()
  if (q) query.set('q', q)
  query.set('offset', String(offset))
  query.set('limit', String(limit))

  let data: PaginatedResult<DatasetCardItem> = { items: [], total: 0, offset: 0, limit: 20 }
  try {
    const res = await serverFetch(`/api/v1/packages?${query}`)
    if (res.ok) {
      data = await res.json()
    }
  } catch {
    // API unavailable (e.g. during build)
  }

  return (
    <div className="mx-auto max-w-[var(--kukan-container-max-width)] px-4 py-8">
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">データセット</h1>
          <p className="text-sm text-muted-foreground">{data.total} 件</p>
        </div>

        <SearchForm action="/dataset" defaultValue={q} />

        <Separator />

        {data.items.length === 0 ? (
          <p className="py-12 text-center text-muted-foreground">
            {q ? `「${q}」に一致するデータセットはありません` : 'データセットがありません'}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {data.items.map((pkg) => (
              <DatasetCard key={pkg.id} pkg={pkg} />
            ))}
          </div>
        )}

        <PaginationNav
          basePath="/dataset"
          params={{ q: q || undefined }}
          offset={offset}
          limit={limit}
          total={data.total}
        />
      </div>
    </div>
  )
}
