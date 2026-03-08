import Link from 'next/link'
import { Button } from '@kukan/ui'
import { buildQuery } from '@/lib/query'

export function PaginationNav({
  basePath,
  params,
  offset,
  limit,
  total,
}: {
  basePath: string
  params?: Record<string, string | undefined>
  offset: number
  limit: number
  total: number
}) {
  const totalPages = Math.ceil(total / limit)
  if (totalPages <= 1) return null

  const currentPage = Math.floor(offset / limit) + 1

  function href(newOffset: number) {
    return `${basePath}?${buildQuery({ ...params, offset: newOffset, limit })}`
  }

  return (
    <div className="flex items-center justify-center gap-2">
      {offset > 0 && (
        <Button asChild variant="outline" size="sm">
          <Link href={href(Math.max(0, offset - limit))}>前へ</Link>
        </Button>
      )}
      <span className="text-sm text-muted-foreground">
        {currentPage} / {totalPages}
      </span>
      {offset + limit < total && (
        <Button asChild variant="outline" size="sm">
          <Link href={href(offset + limit)}>次へ</Link>
        </Button>
      )}
    </div>
  )
}
