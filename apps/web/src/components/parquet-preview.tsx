'use client'

import { Card, CardContent, Skeleton } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import type { ResourceColumn } from '@kukan/shared'
import { useParquetPreview } from '@/hooks/use-parquet-preview'
import { formatCell } from '@/lib/format-utils'
import { KEY_HEADER_CLASS, numericLayout, dataCellClass, decimalAligned } from '@/lib/table-cells'
import { PreviewFooter } from './preview-footer'

interface ParquetPreviewProps {
  resourceId: string
  /** Columns of the resource's primary key, marked the way the picker's sample
   *  marks them so the two screens say it in one colour. */
  primaryKey?: string[] | null
  /** The version's column schema; numeric columns are right-aligned by it. */
  columns?: ResourceColumn[] | null
}

export function ParquetPreview({ resourceId, primaryKey, columns }: ParquetPreviewProps) {
  const t = useTranslations('resource')
  const { metadata, rows, page, totalPages, loading, pageLoading, error, goToPage } =
    useParquetPreview({ resourceId })
  const { isNumeric, maxFractions } = numericLayout(
    metadata?.columns ?? [],
    columns,
    rows,
    (row, col) => formatCell(row[col])
  )

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
                  className={`whitespace-nowrap px-4 py-2 font-medium ${
                    isNumeric(col) ? 'text-right' : 'text-left'
                  } ${primaryKey?.includes(col) ? KEY_HEADER_CLASS : 'text-muted-foreground'}`}
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
                  <td
                    key={ci}
                    className={dataCellClass(isNumeric(col), primaryKey?.includes(col) ?? false)}
                  >
                    {decimalAligned(formatCell(row[col]), maxFractions.get(col) ?? 0)}
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
