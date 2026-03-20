'use client'

import { Card, CardContent, Skeleton } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { useFetch } from '@/hooks/use-fetch'

interface PreviewData {
  headers: string[]
  rows: string[][]
  totalRows: number
  truncated: boolean
  format: string
  encoding: string
}

interface ResourcePreviewProps {
  resourceId: string
  format?: string | null
}

const CSV_FORMATS = new Set(['csv', 'tsv'])
const PDF_FORMATS = new Set(['pdf'])

function getPreviewType(format?: string | null): 'csv' | 'pdf' | null {
  const f = format?.toLowerCase()
  if (f && CSV_FORMATS.has(f)) return 'csv'
  if (f && PDF_FORMATS.has(f)) return 'pdf'
  return null
}

export function ResourcePreview({ resourceId, format }: ResourcePreviewProps) {
  const previewType = getPreviewType(format)

  if (previewType === 'csv') {
    return <CsvPreview resourceId={resourceId} />
  }

  if (previewType === 'pdf') {
    return <PdfPreview resourceId={resourceId} />
  }

  return <PreviewNotAvailable />
}

// --- CSV Preview ---

function CsvPreview({ resourceId }: { resourceId: string }) {
  const t = useTranslations('resource')
  const { data, loading, error } = useFetch<PreviewData>(
    `/api/v1/resources/${encodeURIComponent(resourceId)}/preview`
  )

  if (loading) return <PreviewSkeleton />
  if (error) return <PreviewError />
  if (!data || data.headers.length === 0) return <PreviewEmpty />

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="max-h-[600px] overflow-auto">
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
      <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
        <span>
          {t('previewRowCount', { shown: data.rows.length, total: data.totalRows })}
          {data.truncated && ` (${t('previewTruncatedNote')})`}
        </span>
        <span>{t('previewEncoding', { encoding: data.encoding })}</span>
      </div>
    </div>
  )
}

// --- PDF Preview ---

function PdfPreview({ resourceId }: { resourceId: string }) {
  const t = useTranslations('resource')
  const { data, loading, error } = useFetch<{ url: string }>(
    `/api/v1/resources/${encodeURIComponent(resourceId)}/download-url`
  )

  if (loading) return <PreviewSkeleton />
  if (error || !data?.url) return <PreviewError />

  return (
    <div className="overflow-hidden rounded-lg border">
      <iframe
        src={data.url}
        title={t('preview')}
        className="block h-[700px] w-full"
        style={{ border: 'none' }}
      />
    </div>
  )
}

// --- Shared UI ---

function PreviewNotAvailable() {
  const t = useTranslations('resource')
  return (
    <Card>
      <CardContent className="py-8 text-center text-sm text-muted-foreground">
        {t('previewNotAvailable')}
      </CardContent>
    </Card>
  )
}

function PreviewSkeleton() {
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

function PreviewError() {
  const t = useTranslations('resource')
  return (
    <Card>
      <CardContent className="py-8 text-center text-sm text-muted-foreground">
        {t('previewError')}
      </CardContent>
    </Card>
  )
}

function PreviewEmpty() {
  const t = useTranslations('resource')
  return (
    <Card>
      <CardContent className="py-8 text-center text-sm text-muted-foreground">
        {t('previewEmpty')}
      </CardContent>
    </Card>
  )
}
