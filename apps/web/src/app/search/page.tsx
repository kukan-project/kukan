import Link from 'next/link'
import { Badge, Card, CardContent, CardHeader, CardTitle, Separator } from '@kukan/ui'
import type { PaginatedResult } from '@kukan/shared'
import { serverFetch } from '@/lib/api'
import { SearchForm } from '@/components/search-form'
import { PaginationNav } from '@/components/pagination-nav'

interface DatasetDoc {
  id: string
  name: string
  title?: string
  notes?: string
  organization?: string
  tags?: string[]
}

interface Props {
  searchParams: Promise<{ q?: string; offset?: string; limit?: string }>
}

export default async function SearchPage({ searchParams }: Props) {
  const params = await searchParams
  const q = params.q || ''
  const offset = Number(params.offset) || 0
  const limit = Number(params.limit) || 20

  let data: PaginatedResult<DatasetDoc> = { items: [], total: 0, offset: 0, limit: 20 }

  if (q) {
    const query = new URLSearchParams()
    query.set('q', q)
    query.set('offset', String(offset))
    query.set('limit', String(limit))

    try {
      const res = await serverFetch(`/api/v1/search?${query}`)
      if (res.ok) {
        data = await res.json()
      }
    } catch {
      // API unavailable
    }
  }

  return (
    <div className="mx-auto max-w-[var(--kukan-container-max-width)] px-4 py-8">
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-bold tracking-tight">検索</h1>

        <SearchForm action="/search" defaultValue={q} />

        <Separator />

        {!q ? (
          <p className="py-12 text-center text-muted-foreground">
            キーワードを入力して検索してください
          </p>
        ) : data.items.length === 0 ? (
          <p className="py-12 text-center text-muted-foreground">
            「{q}」に一致するデータセットはありません
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              「{q}」の検索結果: {data.total} 件
            </p>
            <div className="flex flex-col gap-4">
              {data.items.map((item) => (
                <Link key={item.id} href={`/dataset/${item.name}`}>
                  <Card className="transition-colors hover:bg-accent/50">
                    <CardHeader>
                      <CardTitle className="text-lg">{item.title || item.name}</CardTitle>
                      {item.organization && (
                        <p className="text-sm text-muted-foreground">{item.organization}</p>
                      )}
                    </CardHeader>
                    {(item.notes || (item.tags && item.tags.length > 0)) && (
                      <CardContent className="flex flex-col gap-2">
                        {item.notes && (
                          <p className="line-clamp-2 text-sm text-muted-foreground">{item.notes}</p>
                        )}
                        {item.tags && item.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {item.tags.map((t) => (
                              <Badge key={t} variant="secondary" className="text-xs">
                                {t}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    )}
                  </Card>
                </Link>
              ))}
            </div>
          </>
        )}

        {q && (
          <PaginationNav
            basePath="/search"
            params={{ q }}
            offset={offset}
            limit={limit}
            total={data.total}
          />
        )}
      </div>
    </div>
  )
}
