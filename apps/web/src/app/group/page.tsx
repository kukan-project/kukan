import Link from 'next/link'
import { Button, Card, CardContent, Input, Separator } from '@kukan/ui'
import type { PaginatedResult } from '@kukan/shared'
import { serverFetch } from '@/lib/api'

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
  const params = await searchParams
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

  const totalPages = Math.ceil(data.total / limit)
  const currentPage = Math.floor(offset / limit) + 1

  return (
    <div className="mx-auto max-w-[var(--kukan-container-max-width)] px-4 py-8">
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">グループ</h1>
          <p className="text-sm text-muted-foreground">{data.total} 件</p>
        </div>

        <SearchForm defaultValue={q} action="/group" placeholder="グループを検索..." />

        <Separator />

        {data.items.length === 0 ? (
          <p className="py-12 text-center text-muted-foreground">
            {q ? `「${q}」に一致するグループはありません` : 'グループがありません'}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {data.items.map((grp) => (
              <Link key={grp.id} href={`/group/${grp.name}`}>
                <Card className="h-full transition-colors hover:bg-accent/50">
                  <CardContent className="flex flex-col items-center gap-3 px-4 py-6 text-center">
                    <GroupImage imageUrl={grp.imageUrl} name={grp.title || grp.name} />
                    <div className="min-w-0">
                      <p className="font-semibold">{grp.title || grp.name}</p>
                      {grp.description && (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {grp.description}
                        </p>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{grp.datasetCount} データセット</p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2">
            {offset > 0 && (
              <Button asChild variant="outline" size="sm">
                <Link href={`/group?${buildQuery(q, offset - limit, limit)}`}>前へ</Link>
              </Button>
            )}
            <span className="text-sm text-muted-foreground">
              {currentPage} / {totalPages}
            </span>
            {offset + limit < data.total && (
              <Button asChild variant="outline" size="sm">
                <Link href={`/group?${buildQuery(q, offset + limit, limit)}`}>次へ</Link>
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function GroupImage({ imageUrl, name }: { imageUrl?: string | null; name: string }) {
  if (imageUrl) {
    return <img src={imageUrl} alt={name} className="h-16 w-16 rounded-lg object-contain" />
  }
  return (
    <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-muted text-2xl font-bold text-muted-foreground">
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

function SearchForm({
  defaultValue,
  action,
  placeholder,
}: {
  defaultValue: string
  action: string
  placeholder: string
}) {
  return (
    <form action={action} method="GET" className="flex gap-2">
      <Input name="q" type="search" defaultValue={defaultValue} placeholder={placeholder} />
      <Button type="submit" size="sm">
        検索
      </Button>
    </form>
  )
}

function buildQuery(q: string, offset: number, limit: number) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (offset > 0) params.set('offset', String(offset))
  if (limit !== 20) params.set('limit', String(limit))
  return params.toString()
}
