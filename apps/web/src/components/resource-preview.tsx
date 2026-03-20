'use client'

import { useState } from 'react'
import { Card, CardContent, Skeleton, Badge } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { isCsvFormat } from '@kukan/shared'
import { useFetch } from '@/hooks/use-fetch'
import { ParquetPreview } from './parquet-preview'

interface ResourcePreviewProps {
  resourceId: string
  format?: string | null
}

type PreviewSource = 'parquet' | 'raw'

/**
 * Checks for Parquet preview (pipeline output) first.
 * PDF is displayed via Storage signed URL (iframe).
 * TXT is displayed as raw text.
 * If no preview data exists in Storage, shows "not available".
 */
export function ResourcePreview({ resourceId, format }: ResourcePreviewProps) {
  const f = format?.toLowerCase()

  // PDF: render via Storage signed URL
  if (f === 'pdf') return <PdfPreview resourceId={resourceId} />

  // TXT: text-only preview (no preview-url fetch needed)
  if (f === 'txt') return <TextOnlyPreview resourceId={resourceId} />

  // CSV/TSV and other formats: check for Parquet preview
  return <TablePreview resourceId={resourceId} format={format} />
}

function TextOnlyPreview({ resourceId }: { resourceId: string }) {
  const t = useTranslations('resource')

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Badge variant="default">{t('previewSourceText')}</Badge>
      </div>
      <RawTextPreview resourceId={resourceId} />
    </div>
  )
}

function TablePreview({ resourceId, format }: ResourcePreviewProps) {
  const t = useTranslations('resource')
  const [source, setSource] = useState<PreviewSource>('parquet')
  const { data, loading } = useFetch<{ url: string | null }>(
    `/api/v1/resources/${encodeURIComponent(resourceId)}/preview-url`
  )

  if (loading) return <PreviewSkeleton />

  const hasParquet = !!data?.url

  if (!hasParquet) {
    return isCsvFormat(format) ? <PreviewNoData /> : <PreviewNotAvailable />
  }

  const sources: { key: PreviewSource; label: string }[] = [
    { key: 'parquet', label: t('previewSourceTable') },
    { key: 'raw', label: t('previewSourceText') },
  ]

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        {sources.map((s) => (
          <Badge
            key={s.key}
            variant={source === s.key ? 'default' : 'outline'}
            className="cursor-pointer"
            onClick={() => setSource(s.key)}
          >
            {s.label}
          </Badge>
        ))}
      </div>
      {source === 'parquet' && <ParquetPreview resourceId={resourceId} />}
      {source === 'raw' && <RawTextPreview resourceId={resourceId} />}
    </div>
  )
}

// --- Raw Text Preview ---

function RawTextPreview({ resourceId }: { resourceId: string }) {
  const t = useTranslations('resource')
  const { data, loading, error } = useFetch<{ text: string; encoding: string }>(
    `/api/v1/resources/${encodeURIComponent(resourceId)}/raw`
  )

  if (loading) return <PreviewSkeleton />
  if (error) return <PreviewError />
  if (!data?.text) return <PreviewEmpty />

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="max-h-[600px] overflow-auto bg-muted/20 p-4">
        <pre className="whitespace-pre text-xs">{data.text}</pre>
      </div>
      <div className="border-t px-4 py-2 text-xs text-muted-foreground">
        {t('previewEncoding', { encoding: data.encoding })}
      </div>
    </div>
  )
}

// --- PDF Preview ---

function PdfPreview({ resourceId }: { resourceId: string }) {
  const t = useTranslations('resource')
  const { data, loading, error } = useFetch<{ url: string | null }>(
    `/api/v1/resources/${encodeURIComponent(resourceId)}/preview-url`
  )

  if (loading) return <PreviewSkeleton />
  if (error || !data?.url) return <PreviewNotAvailable />

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

function PreviewNoData() {
  const t = useTranslations('resource')
  return (
    <Card>
      <CardContent className="py-8 text-center text-sm text-muted-foreground">
        {t('previewNoData')}
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
