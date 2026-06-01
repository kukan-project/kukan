'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@kukan/ui'
import { useTranslations } from 'next-intl'

interface ExplorerPaginationProps {
  page: number
  totalPages: number
  totalRows: number
  filteredRows: number
  loading: boolean
  onPageChange: (page: number) => void
}

export function ExplorerPagination({
  page,
  totalPages,
  totalRows,
  filteredRows,
  loading,
  onPageChange,
}: ExplorerPaginationProps) {
  const t = useTranslations('resource')
  const isFiltered = filteredRows !== totalRows

  return (
    <div className="flex items-center justify-between text-sm text-muted-foreground">
      <span>
        {isFiltered
          ? t('explorerFilteredRows', {
              filtered: filteredRows.toLocaleString(),
              total: totalRows.toLocaleString(),
            })
          : t('previewTotalRows', { count: totalRows.toLocaleString() })}
      </span>
      <div className="flex items-center gap-2">
        <span>{t('previewPage', { current: page + 1, total: totalPages })}</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={page === 0 || loading}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={page >= totalPages - 1 || loading}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  )
}
