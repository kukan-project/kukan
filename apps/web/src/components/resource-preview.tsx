'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, Skeleton, Badge } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import {
  isCsvFormat,
  isTextFormat,
  isZipFormat,
  isOfficeFormat,
  isPdfFormat,
  isGeoJsonFormat,
} from '@kukan/shared'
import { clientFetch } from '@/lib/client-api'
import { ParquetPreview } from './parquet-preview'
import { GeoJsonPreview } from './geojson-preview'
import { ZipPreview } from './zip-preview'

interface ResourcePreviewProps {
  resourceId: string
  format?: string | null
  /** Original URL for external URL resources (used by Office Online Viewer) */
  url?: string | null
  /** File size in bytes (used for Office Online Viewer 10 MB limit check) */
  size?: number | null
}

type PreviewSource = 'parquet' | 'raw'

/**
 * Checks for Parquet preview (pipeline output) first.
 * PDF is displayed via Storage signed URL (iframe).
 * TXT is displayed as raw text.
 * If no preview data exists in Storage, shows "not available".
 */
export function ResourcePreview({ resourceId, format, url, size }: ResourcePreviewProps) {
  const f = format ?? null

  if (isPdfFormat(f)) return <PdfPreview resourceId={resourceId} />
  if (isCsvFormat(f)) return <TablePreview resourceId={resourceId} />
  if (isGeoJsonFormat(f)) return <GeoJsonPreview resourceId={resourceId} />
  if (isZipFormat(f)) return <ZipPreview resourceId={resourceId} />
  if (isOfficeFormat(f))
    return <OfficeOnlinePreview resourceId={resourceId} url={url} size={size} />
  if (isTextFormat(f)) return <TextOnlyPreview resourceId={resourceId} />
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
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await clientFetch(`/api/v1/resources/${encodeURIComponent(resourceId)}/text`)
        if (!res.ok) throw new Error()
        if (cancelled) return

        setEncoding(res.headers.get('X-Detected-Encoding') || '')
        setTruncated(res.headers.get('X-Truncated') === 'true')

        const ct = res.headers.get('Content-Type') || ''
        const charsetMatch = ct.match(/charset=([^\s;]+)/)
        const charset = charsetMatch?.[1] || 'utf-8'
        const buf = await res.arrayBuffer()
        const decoded = new TextDecoder(charset).decode(buf)
        // Remove trailing replacement chars from truncated multi-byte sequences
        setText(decoded.replace(/\uFFFD+$/, ''))
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
      {(encoding || truncated) && (
        <div className="flex items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
          {encoding && <span>{t('previewEncoding', { encoding })}</span>}
          {truncated && <span>{t('previewTruncated')}</span>}
        </div>
      )}
    </div>
  )
}

// --- PDF Preview ---

function PdfPreview({ resourceId }: { resourceId: string }) {
  const t = useTranslations('resource')
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const previewUrl = `/api/v1/resources/${encodeURIComponent(resourceId)}/preview`

  useEffect(() => {
    let cancelled = false
    async function check() {
      try {
        const res = await clientFetch(previewUrl, { method: 'HEAD' })
        if (!cancelled) setState(res.ok ? 'ready' : 'error')
      } catch {
        if (!cancelled) setState('error')
      }
    }
    check()
    return () => {
      cancelled = true
    }
  }, [resourceId])

  if (state === 'loading') return <PreviewSkeleton />
  if (state === 'error') return <PreviewError />

  return (
    <div className="overflow-hidden rounded-lg border">
      <iframe
        src={previewUrl}
        title={t('preview')}
        className="block h-[700px] w-full"
        style={{ border: 'none' }}
      />
    </div>
  )
}

// --- Office Online Preview (Excel / Word) ---

const OFFICE_VIEWER_BASE = 'https://view.officeapps.live.com/op/embed.aspx'

/** Office Online Viewer file size limit (10 MB) */
const OFFICE_VIEWER_MAX_SIZE = 10 * 1024 * 1024

function OfficeOnlinePreview({
  resourceId,
  url,
  size,
}: {
  resourceId: string
  url?: string | null
  size?: number | null
}) {
  const t = useTranslations('resource')
  // Phase: 'visible' → 'fading' → 'hidden'
  const [phase, setPhase] = useState<'visible' | 'fading' | 'hidden'>('visible')

  useEffect(() => {
    const fadeTimer = setTimeout(() => setPhase('fading'), 1000)
    return () => clearTimeout(fadeTimer)
  }, [])
  useEffect(() => {
    if (phase !== 'fading') return
    const removeTimer = setTimeout(() => setPhase('hidden'), 1000)
    return () => clearTimeout(removeTimer)
  }, [phase])

  const isLocal =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')

  // External URL resources: use original URL directly (works even on localhost)
  // Uploaded resources: use KUKAN API endpoint (requires public deployment)
  let fileUrl: string | null = null
  if (url) {
    fileUrl = url
  } else if (!isLocal && typeof window !== 'undefined') {
    fileUrl = `${window.location.origin}/api/v1/resources/${encodeURIComponent(resourceId)}/preview`
  }

  if (size && size > OFFICE_VIEWER_MAX_SIZE) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('previewOfficeTooLarge')}
        </CardContent>
      </Card>
    )
  }

  if (!fileUrl) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('previewOfficeLocalUnavailable')}
        </CardContent>
      </Card>
    )
  }

  const viewerUrl = `${OFFICE_VIEWER_BASE}?src=${encodeURIComponent(fileUrl)}`

  return (
    <div className="flex flex-col gap-1">
      <div className="relative overflow-hidden rounded-lg border">
        {phase !== 'hidden' && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-background transition-opacity duration-[1000ms]"
            style={{ opacity: phase === 'fading' ? 0 : 1 }}
          >
            <div className="flex flex-col items-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted-foreground/20 border-t-primary" />
              <p className="text-sm text-muted-foreground">{t('previewLoading')}</p>
            </div>
          </div>
        )}
        <iframe
          src={viewerUrl}
          title={t('preview')}
          className="block h-[700px] w-full"
          style={{ border: 'none' }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t('previewOfficeOnline')}</p>
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
