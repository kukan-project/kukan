'use client'

import { Card, CardContent, Skeleton } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { useParquetPreview } from '@/hooks/use-parquet-preview'
import { formatCell } from '@/lib/format-utils'
import { PreviewFooter } from './preview-footer'

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

  if (!metadata) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('previewNoData')}
        </CardContent>
      </Card>
    )
  }

  if (metadata.numRows === 0) {
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
          <thead className="sticky top-0 z-10 border-b bg-muted">
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
                    {formatCell(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PreviewFooter
        summary={t('previewTotalRows', { count: metadata.numRows })}
        page={page}
        totalPages={totalPages}
        busy={pageLoading}
        onPageChange={goToPage}
      />
    </div>
  )
}
