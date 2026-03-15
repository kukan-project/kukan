'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@kukan/ui'

export function PaginationControls({
  offset,
  total,
  pageSize,
  totalPages,
  currentPage,
  onPageChange,
}: {
  offset: number
  total: number
  pageSize: number
  totalPages: number
  currentPage: number
  onPageChange: (newOffset: number) => void
}) {
  const tc = useTranslations('common')

  if (totalPages <= 1) return null

  return (
    <div className="flex items-center justify-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={offset === 0}
        onClick={() => onPageChange(Math.max(0, offset - pageSize))}
      >
        {tc('previous')}
      </Button>
      <span className="text-sm text-muted-foreground">
        {currentPage} / {totalPages}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={offset + pageSize >= total}
        onClick={() => onPageChange(offset + pageSize)}
      >
        {tc('next')}
      </Button>
    </div>
  )
}
