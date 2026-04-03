'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, Skeleton, Badge } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { isCsvFormat, isTextFormat, isZipFormat } from '@kukan/shared'
import { clientFetch } from '@/lib/client-api'
import { ParquetPreview } from './parquet-preview'
import { GeoJsonPreview } from './geojson-preview'
import { ZipPreview } from './zip-preview'

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

  // CSV/TSV: Parquet table with raw text toggle
  if (isCsvFormat(format)) return <TablePreview resourceId={resourceId} />

  // GeoJSON: map with raw text toggle
  if (f === 'geojson') return <GeoJsonPreview resourceId={resourceId} />

  // ZIP: file listing preview
  if (isZipFormat(format ?? null)) return <ZipPreview resourceId={resourceId} />

  // Text formats (JSON, XML, HTML, TXT, MD, etc.): raw text preview
  if (isTextFormat(format ?? null)) return <TextOnlyPreview resourceId={resourceId} />

  // Non-text formats (XLSX, DOC, etc.): not available
  return <PreviewNotAvailable />
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

function TablePreview({ resourceId }: { resourceId: string }) {
  const t = useTranslations('resource')
  const [source, setSource] = useState<PreviewSource>('parquet')

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

// --- Text Preview ---

function RawTextPreview({ resourceId }: { resourceId: string }) {
  const t = useTranslations('resource')
  const [text, setText] = useState<string | null>(null)
  const [encoding, setEncoding] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await clientFetch(`/api/v1/resources/${encodeURIComponent(resourceId)}/text`)
        if (!res.ok) throw new Error()
        if (!cancelled) {
          const detectedEncoding = res.headers.get('X-Detected-Encoding') || ''
          setEncoding(detectedEncoding)
          // Extract charset from Content-Type and decode with TextDecoder
          // (fetch's res.text() always decodes as UTF-8, ignoring charset)
          const ct = res.headers.get('Content-Type') || ''
          const charsetMatch = ct.match(/charset=([^\s;]+)/)
          const charset = charsetMatch?.[1] || 'utf-8'
          const buf = await res.arrayBuffer()
          setText(new TextDecoder(charset).decode(buf))
        }
      } catch {
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [resourceId])

  if (loading) return <PreviewSkeleton />
  if (error) return <PreviewError />
  if (!text) return <PreviewEmpty />

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="max-h-[600px] overflow-auto bg-muted/20 p-4">
        <pre className="whitespace-pre text-xs">{text}</pre>
      </div>
      {encoding && (
        <div className="border-t px-4 py-2 text-xs text-muted-foreground">
          {t('previewEncoding', { encoding })}
        </div>
      )}
    </div>
  )
}

// --- PDF Preview ---

function PdfPreview({ resourceId }: { resourceId: string }) {
  const t = useTranslations('resource')

  return (
    <div className="overflow-hidden rounded-lg border">
      <iframe
        src={`/api/v1/resources/${encodeURIComponent(resourceId)}/preview`}
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
