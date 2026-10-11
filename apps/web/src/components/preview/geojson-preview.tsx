'use client'

import { useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { Card, CardContent, Skeleton } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import type { ResourceSchema } from '@kukan/shared'
import { clientFetch } from '@/lib/client-api'
import { DataExplorer } from '@/components/data-explorer/data-explorer'
import { highlightJson } from './json-preview'
import { SourceToggle } from './resource-preview'

const GeoJsonMap = dynamic(() => import('./geojson-map'), {
  ssr: false,
  loading: () => <MapSkeleton />,
})

type PreviewSource = 'map' | 'table' | 'json'

interface GeoJsonPreviewProps {
  resourceId: string
  /**
   * The features' properties as the interpretation read them (ADR-063
   * extension) — the attribute table behind the map. Absent where it made none.
   */
  schema?: ResourceSchema | null
  /** The resource's settled primary key, marked in the table as a CSV's is */
  primaryKey?: string[] | null
}

export function GeoJsonPreview({ resourceId, schema, primaryKey }: GeoJsonPreviewProps) {
  const t = useTranslations('resource')
  const [source, setSource] = useState<PreviewSource>('map')
  const hasTable = (schema?.columns.length ?? 0) > 0
  const [geoJson, setGeoJson] = useState<GeoJSON.GeoJsonObject | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<'generic' | 'too-large' | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await clientFetch(`/api/v1/resources/${encodeURIComponent(resourceId)}/json`)
        if (!res.ok) {
          if (!cancelled) setError(res.status === 413 ? 'too-large' : 'generic')
          return
        }
        const parsed = await res.json()
        if (!cancelled) {
          setGeoJson(parsed as GeoJSON.GeoJsonObject)
        }
      } catch {
        if (!cancelled) setError('generic')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [resourceId])

  const jsonNodes = useMemo(
    () => (source === 'json' && geoJson ? highlightJson(JSON.stringify(geoJson, null, 2)) : null),
    [source, geoJson]
  )

  // The table is read from the Parquet, so it stands where the file is too
  // large to draw or has not arrived yet
  const file = loading ? (
    <MapSkeleton />
  ) : error || !geoJson ? (
    <Card>
      <CardContent className="py-8 text-center text-sm text-muted-foreground">
        {t(error === 'too-large' ? 'previewJsonTooLarge' : 'previewError')}
      </CardContent>
    </Card>
  ) : null
  if (file && !hasTable) return file

  const sources: { key: PreviewSource; label: string }[] = [
    { key: 'map', label: t('previewSourceMap') },
    ...(hasTable ? [{ key: 'table' as const, label: t('previewSourceAttributes') }] : []),
    { key: 'json', label: 'JSON' },
  ]

  return (
    <div className="flex flex-col gap-2">
      <SourceToggle sources={sources} value={source} onChange={setSource} />
      {source === 'map' && (file ?? <GeoJsonMap data={geoJson!} />)}
      {source === 'table' && (
        <DataExplorer
          resourceId={resourceId}
          primaryKey={primaryKey}
          schemaColumns={schema!.columns}
        />
      )}
      {source === 'json' && file}
      {source === 'json' && jsonNodes && (
        <div className="overflow-hidden rounded-lg border">
          <div className="max-h-[600px] overflow-auto bg-muted/20 p-4">
            <pre className="whitespace-pre text-xs leading-relaxed">{jsonNodes}</pre>
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
