'use client'

import { useState, useCallback, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Calendar } from 'lucide-react'
import { Card, CardContent, cn } from '@kukan/ui'
import { getFormatColorClass } from '@/lib/format-colors'
import { formatBytes } from '@/lib/format-utils'
import { renderSimpleMarkdown } from '@/lib/render-markdown'
import { DownloadButton } from '@/components/download-button'
import { ResourcePipelinePreview } from '@/components/resource-pipeline-preview'
import { KeyValueTable, extrasToRows } from '@/components/key-value-table'
import { DateTime } from '@/components/date-time'

export interface Resource {
  id: string
  name?: string | null
  url?: string | null
  urlType?: string | null
  description?: string | null
  format?: string | null
  size?: number | null
  mimetype?: string | null
  hash?: string | null
  resourceType?: string | null
  created: string
  updated: string
  lastModified?: string | null
  extras?: Record<string, unknown> | null
}

interface ResourceExplorerProps {
  resources: Resource[]
  packageName: string
  sectionTitle?: string
  initialResourceId?: string
  canManage?: boolean
}

function getResourceIdFromPath(): string | null {
  const match = window.location.pathname.match(/\/dataset\/[^/]+\/resource\/([^/]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

export function ResourceExplorer({
  resources,
  packageName,
  sectionTitle,
  initialResourceId,
  canManage,
}: ResourceExplorerProps) {
  const t = useTranslations('resource')
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (initialResourceId && resources.some((r) => r.id === initialResourceId)) {
      return initialResourceId
    }
    return resources[0]?.id ?? null
  })
  const selected = resources.find((r) => r.id === selectedId)

  // Sync with browser back/forward
  useEffect(() => {
    const onPopState = () => {
      const id = getResourceIdFromPath()
      if (id && resources.some((r) => r.id === id)) {
        setSelectedId(id)
      } else {
        setSelectedId(resources[0]?.id ?? null)
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [resources])

  const selectResource = useCallback(
    (id: string) => {
      setSelectedId(id)
      const url = `/dataset/${encodeURIComponent(packageName)}/resource/${encodeURIComponent(id)}`
      window.history.pushState(null, '', url)
    },
    [packageName]
  )

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      {/* Resource list (left) */}
      <div className="flex flex-col lg:w-80 lg:shrink-0">
        {sectionTitle && <h2 className="mb-4 text-xl font-semibold">{sectionTitle}</h2>}
        <div className="flex max-h-[calc(100svh-12rem)] flex-col gap-2 overflow-y-auto">
          {resources.map((r) => (
            <Card
              key={r.id}
              className={cn(
                'cursor-pointer py-0 transition-shadow',
                r.id === selectedId && 'ring-2 ring-inset ring-primary'
              )}
              onClick={() => selectResource(r.id)}
            >
              <CardContent className="flex items-center gap-3 px-3 py-2.5">
                <span
                  className={`inline-flex min-w-[48px] items-center justify-center rounded px-1.5 py-0.5 text-xs font-bold uppercase ${getFormatColorClass(r.format)}`}
                >
                  {r.format || '?'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.name || t('unnamed')}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Selected resource preview (right) */}
      {selected && (
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {/* Resource header */}
          <div className="flex items-center justify-between gap-3">
            <h3 className="truncate text-xl leading-tight font-semibold">
              {selected.name || t('unnamed')}
            </h3>
            <div className="shrink-0">
              <DownloadButton
                datasetNameOrId={packageName}
                resourceId={selected.id}
                filename={selected.url || selected.id}
                label={t('download')}
                size={selected.size}
              />
            </div>
          </div>

          <div className="flex flex-col items-end gap-1 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {t('createdShort')}: <DateTime value={selected.created} />
            </span>
            <span className="flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {t('updatedShort')}: <DateTime value={selected.updated} />
            </span>
          </div>

          {selected.description && (
            <div className="prose max-w-none text-sm text-muted-foreground">
              {renderSimpleMarkdown(selected.description)}
            </div>
          )}

          <ResourcePipelinePreview
            resourceId={selected.id}
            format={selected.format}
            canManage={canManage}
          />

          {/* Resource metadata (collapsible) */}
          <details className="group">
            <summary className="cursor-pointer text-sm font-medium text-muted-foreground list-none flex items-center gap-2 [&::-webkit-details-marker]:hidden">
              <span className="transition-transform group-open:rotate-90">&#9654;</span>
              {t('additionalInfo')}
            </summary>
            <div className="mt-4">
              <KeyValueTable
                rows={[
                  {
                    label: t('lastModified'),
                    value: selected.lastModified ? (
                      <DateTime value={selected.lastModified} />
                    ) : null,
                  },
                  { label: t('updated'), value: <DateTime value={selected.updated} /> },
                  { label: t('created'), value: <DateTime value={selected.created} /> },
                  { label: t('dataFormat'), value: selected.format?.toUpperCase() },
                  { label: t('mimeType'), value: selected.mimetype },
                  { label: t('size'), value: formatBytes(selected.size) },
                  { label: t('resourceType'), value: selected.resourceType },
                  { label: t('hash'), value: selected.hash },
                  ...extrasToRows(selected.extras),
                ]}
              />
            </div>
          </details>
        </div>
      )}
    </div>
  )
}
