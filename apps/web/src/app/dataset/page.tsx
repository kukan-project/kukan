import Link from 'next/link'
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Separator } from '@kukan/ui'
import type { PaginatedResult } from '@kukan/shared'
import { serverFetch } from '@/lib/api'

interface Package {
  id: string
  name: string
  title?: string
  notes?: string
  owner_org?: string
  private: boolean
  metadata_modified: string
}

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

  let data: PaginatedResult<Package> = { items: [], total: 0, offset: 0, limit: 20 }
  try {
    const res = await serverFetch(`/api/v1/packages?${query}`)
    if (res.ok) {
      data = await res.json()
    }
  } catch {
    // API unavailable (e.g. during build)
  }

  const totalPages = Math.ceil(data.total / limit)
  const currentPage = Math.floor(offset / limit) + 1

  return (
    <div className="mx-auto max-w-[var(--kukan-container-max-width)] px-4 py-8">
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">データセット</h1>
          <p className="text-sm text-muted-foreground">{data.total} 件</p>
        </div>

        <SearchForm defaultValue={q} />

        <Separator />

        {data.items.length === 0 ? (
          <p className="py-12 text-center text-muted-foreground">
            {q ? `「${q}」に一致するデータセットはありません` : 'データセットがありません'}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {data.items.map((pkg) => (
              <Link key={pkg.id} href={`/dataset/${pkg.name}`}>
                <Card className="transition-colors hover:bg-accent/50">
                  <CardHeader>
                    <CardTitle className="text-lg">{pkg.title || pkg.name}</CardTitle>
                  </CardHeader>
                  {pkg.notes && (
                    <CardContent>
                      <p className="line-clamp-2 text-sm text-muted-foreground">{pkg.notes}</p>
                    </CardContent>
                  )}
                </Card>
              </Link>
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2">
            {offset > 0 && (
              <Button asChild variant="outline" size="sm">
                <Link href={`/dataset?${buildQuery(q, offset - limit, limit)}`}>前へ</Link>
              </Button>
            )}
            <span className="text-sm text-muted-foreground">
              {currentPage} / {totalPages}
            </span>
            {offset + limit < data.total && (
              <Button asChild variant="outline" size="sm">
                <Link href={`/dataset?${buildQuery(q, offset + limit, limit)}`}>次へ</Link>
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function buildQuery(q: string, offset: number, limit: number) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (offset > 0) params.set('offset', String(offset))
  if (limit !== 20) params.set('limit', String(limit))
  return params.toString()
}

function SearchForm({ defaultValue }: { defaultValue: string }) {
  return (
    <form action="/dataset" method="GET" className="flex gap-2">
      <Input
        name="q"
        type="search"
        defaultValue={defaultValue}
        placeholder="データセットを検索..."
      />
      <Button type="submit" size="sm">
        検索
      </Button>
    </form>
  )
}
