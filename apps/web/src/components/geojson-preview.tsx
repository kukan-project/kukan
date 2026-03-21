'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { Card, CardContent, Skeleton, Badge } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'

const GeoJsonMap = dynamic(() => import('./geojson-map'), {
  ssr: false,
  loading: () => <MapSkeleton />,
})

type PreviewSource = 'map' | 'raw'

interface GeoJsonPreviewProps {
  resourceId: string
}

export function GeoJsonPreview({ resourceId }: GeoJsonPreviewProps) {
  const t = useTranslations('resource')
  const [source, setSource] = useState<PreviewSource>('map')
  const [geoJson, setGeoJson] = useState<GeoJSON.GeoJsonObject | null>(null)
  const [rawText, setRawText] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await clientFetch(`/api/v1/resources/${encodeURIComponent(resourceId)}/text`)
        if (!res.ok) throw new Error()
        const text = await res.text()
        if (!cancelled) {
          setRawText(text)
          setGeoJson(JSON.parse(text) as GeoJSON.GeoJsonObject)
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

  if (loading) return <MapSkeleton />
  if (error || !geoJson) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('previewError')}
        </CardContent>
      </Card>
    )
  }

  const sources: { key: PreviewSource; label: string }[] = [
    { key: 'map', label: t('previewSourceMap') },
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
      {source === 'map' && <GeoJsonMap data={geoJson} />}
      {source === 'raw' && rawText && (
        <div className="overflow-hidden rounded-lg border">
          <div className="max-h-[600px] overflow-auto bg-muted/20 p-4">
            <pre className="whitespace-pre text-xs">{rawText}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

function MapSkeleton() {
  return (
    <Card>
      <CardContent className="p-0">
        <Skeleton className="h-[500px] w-full rounded-lg" />
      </CardContent>
    </Card>
  )
}
