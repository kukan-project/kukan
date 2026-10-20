import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@kukan/ui'
import { buildQuery } from '@/lib/query'

export function PaginationNav({
  basePath,
  params,
  offset,
  limit,
  total,
  maxResults = Infinity,
}: {
  basePath: string
  params?: Record<string, string | string[] | undefined>
  offset: number
  limit: number
  total: number
  /** How deep the pages go, where the list cannot be paged to its end (a search's result window) */
  maxResults?: number
}) {
  const t = useTranslations('common')
  // Only whole pages inside the cap: a part page would reach beyond it
  const totalPages = Math.min(Math.ceil(total / limit), Math.floor(maxResults / limit))
  if (totalPages <= 1) return null

  const currentPage = Math.floor(offset / limit) + 1

  function href(newOffset: number) {
    return `${basePath}?${buildQuery({ ...params, offset: newOffset, limit })}`
  }

  return (
    <div className="flex items-center justify-center gap-2">
      {offset > 0 && (
        <Button asChild variant="outline" size="sm">
          <Link href={href(Math.max(0, offset - limit))}>{t('previous')}</Link>
        </Button>
      )}
      <span className="text-sm text-muted-foreground">
        {currentPage} / {totalPages}
      </span>
      {offset + limit < total && offset + 2 * limit <= maxResults && (
        <Button asChild variant="outline" size="sm">
          <Link href={href(offset + limit)}>{t('next')}</Link>
        </Button>
      )}
    </div>
  )
}
