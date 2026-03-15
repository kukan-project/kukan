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
}: {
  basePath: string
  params?: Record<string, string | undefined>
  offset: number
  limit: number
  total: number
}) {
  const t = useTranslations('common')
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
          <Link href={href(Math.max(0, offset - limit))}>{t('previous')}</Link>
        </Button>
      )}
      <span className="text-sm text-muted-foreground">
        {currentPage} / {totalPages}
      </span>
      {offset + limit < total && (
        <Button asChild variant="outline" size="sm">
          <Link href={href(offset + limit)}>{t('next')}</Link>
        </Button>
      )}
    </div>
  )
}
