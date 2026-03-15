'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, Skeleton } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'

interface PreviewData {
  headers: string[]
  rows: string[][]
  totalRows: number
  truncated: boolean
  format: string
  encoding: string
}

interface CsvPreviewTableProps {
  resourceId: string
  format?: string | null
}

export function CsvPreviewTable({ resourceId, format }: CsvPreviewTableProps) {
  const t = useTranslations('resource')
  const [data, setData] = useState<PreviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const isCsv = format?.toLowerCase() === 'csv'

  useEffect(() => {
    if (!isCsv) {
      setLoading(false)
      return
    }

    let cancelled = false

    async function load() {
      try {
        const res = await clientFetch(
          `/api/v1/resources/${encodeURIComponent(resourceId)}/preview`
        )
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          throw new Error(body?.detail || 'Failed to load preview')
        }
        const preview: PreviewData = await res.json()
        if (!cancelled) setData(preview)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Unknown error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [resourceId, isCsv])

  if (!isCsv) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('previewNotAvailable')}
        </CardContent>
      </Card>
    )
  }

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

  if (!data || data.headers.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('previewEmpty')}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="max-h-[600px] overflow-auto rounded border">
          <table className="w-max border-collapse text-sm">
            <thead className="sticky top-0 z-10 border-b bg-muted/50">
              <tr>
                {data.headers.map((header, i) => (
                  <th
                    key={i}
                    className="whitespace-nowrap px-4 py-2 text-left font-medium text-muted-foreground"
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, ri) => (
                <tr key={ri} className="border-b last:border-b-0">
                  {row.map((cell, ci) => (
                    <td key={ci} className="whitespace-nowrap px-4 py-2">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between pt-3 text-xs text-muted-foreground">
          <span>
            {t('previewRowCount', { shown: data.rows.length, total: data.totalRows })}
            {data.truncated && ` (${t('previewTruncatedNote')})`}
          </span>
          <span>{t('previewEncoding', { encoding: data.encoding })}</span>
        </div>
      </CardContent>
    </Card>
  )
}
