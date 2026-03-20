'use client'

import { Button, Card, CardContent, Skeleton } from '@kukan/ui'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useParquetPreview } from '@/hooks/use-parquet-preview'

interface ParquetPreviewProps {
  resourceId: string
}

export function ParquetPreview({ resourceId }: ParquetPreviewProps) {
  const t = useTranslations('resource')
  const { metadata, rows, page, totalPages, loading, pageLoading, error, goToPage } =
    useParquetPreview({ resourceId })

  if (loading) {
    return (
      <Card>
        <CardContent className="space-y-3 p-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('previewError')}
        </CardContent>
      </Card>
    )
  }

  if (!metadata || metadata.numRows === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('previewEmpty')}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="relative max-h-[600px] overflow-auto">
        {pageLoading && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/50">
            <span className="text-sm text-muted-foreground">{t('previewLoadingPage')}</span>
          </div>
        )}
        <table className="w-max border-collapse text-sm">
          <thead className="sticky top-0 z-10 border-b bg-muted/50">
            <tr>
              {metadata.columns.map((col, i) => (
                <th
                  key={i}
                  className="whitespace-nowrap px-4 py-2 text-left font-medium text-muted-foreground"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className="border-b last:border-b-0">
                {metadata.columns.map((col, ci) => (
                  <td key={ci} className="whitespace-nowrap px-4 py-2">
                    {row[col] != null ? String(row[col]) : ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
        <span>{t('previewTotalRows', { count: metadata.numRows })}</span>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1"
              disabled={page === 0 || pageLoading}
              onClick={() => goToPage(page - 1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span>{t('previewPage', { current: page + 1, total: totalPages })}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1"
              disabled={page >= totalPages - 1 || pageLoading}
              onClick={() => goToPage(page + 1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
