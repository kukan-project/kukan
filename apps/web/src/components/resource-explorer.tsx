'use client'

import { Fragment, useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Calendar, ExternalLink } from 'lucide-react'
import { Card, CardContent, cn } from '@kukan/ui'
import { FormatBadge } from './format-badge'
import { formatBytes } from '@/lib/format-utils'
import { renderSimpleMarkdown } from '@/lib/render-markdown'
import { DownloadButton } from '@/components/download-button'
import { ResourcePipelinePreview } from '@/components/resource-pipeline-preview'
import { KeyValueTable, extrasToRows } from '@/components/key-value-table'
import { DateTime, useFormattedDateTime } from '@/components/date-time'
import { VersionHistory } from '@/components/version-history'
import { externalHttpUrl } from '@/lib/safe-url'
import { LinkHealthWarning } from '@/components/link-health-warning'
import { sectionLayout } from '@kukan/shared'
import { indentClass, headingTag } from '@/lib/resource-sections'

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
  healthStatus?: string | null
  healthCheckedAt?: string | null
  extras?: Record<string, unknown> | null
  section?: string | null
}

interface ResourceExplorerProps {
  resources: Resource[]
  packageName: string
  sectionTitle?: string
  initialResourceId?: string
  canManage?: boolean
}

/**
 * A resource's URL when it points at another site — an upload's names our own.
 *
 * Tested by exclusion because `upload` is the only value the validator admits
 * (`createResourceBodySchema`); anything else, `null` included, is a fetch.
 */
function externalUrl(resource: Resource | undefined): string | null {
  return resource && resource.urlType !== 'upload' ? (resource.url ?? null) : null
}

/**
 * How the source URL reads on the page: the host, with a marker when the URL
 * carries more than that. Full paths are long enough to push the dates around;
 * the whole URL stays on the link itself and in its tooltip.
 */
function shortenUrl({ host, pathname, search }: URL): string {
  return pathname === '/' && !search ? host : `${host}/…`
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
  // Headings and depths depend only on the list, so they are settled once per list
  const layout = useMemo(() => sectionLayout(resources), [resources])
  const source = externalHttpUrl(externalUrl(selected))
  // Only the verdict is public — what went wrong is the sysadmin health
  // screen's to show, so this says the link may be gone and when that was last
  // true, not which status or error came back.
  const checkedAt = useFormattedDateTime(
    source && selected?.healthStatus === 'error' ? selected.healthCheckedAt : null
  )
  const linkWarning = checkedAt ? t('linkCheckFailed', { date: checkedAt }) : null

  // Track visited resource IDs to keep their previews alive in the DOM
  const [visitedIds, setVisitedIds] = useState<Set<string>>(() => {
    const initial = new Set<string>()
    if (selectedId) initial.add(selectedId)
    return initial
  })

  const addVisited = useCallback((id: string) => {
    setVisitedIds((prev) => {
      if (prev.has(id)) return prev
      return new Set(prev).add(id)
    })
  }, [])

  // Sync with browser back/forward
  useEffect(() => {
    const onPopState = () => {
      const id = getResourceIdFromPath()
      if (id && resources.some((r) => r.id === id)) {
        setSelectedId(id)
        addVisited(id)
      } else {
        setSelectedId(resources[0]?.id ?? null)
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [resources, addVisited])

  const selectResource = useCallback(
    (id: string) => {
      setSelectedId(id)
      addVisited(id)
      const url = `/dataset/${encodeURIComponent(packageName)}/resource/${encodeURIComponent(id)}`
      window.history.pushState(null, '', url)
    },
    [packageName, addVisited]
  )

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      {/* Resource list (left) */}
      <div className="flex flex-col lg:w-80 lg:shrink-0">
        {sectionTitle && <h2 className="mb-4 text-xl font-semibold">{sectionTitle}</h2>}
        <div className="flex flex-col gap-1.5">
          {resources.map((r, i) => (
            <Fragment key={r.id}>
              {layout[i].headings.map(({ depth, label }) => {
                // One element per depth so the outline nests under the list's h2 (ADR-050)
                const Heading = headingTag(depth)
                return (
                  <Heading
                    key={`${r.id}:${depth}`}
                    className={cn(
                      'truncate font-semibold',
                      indentClass(depth - 1),
                      // Three tiers to match h3/h4/h5: rule, dark, muted — and the
                      // same breath below each as the top level has, so a sub
                      // heading reads as a heading rather than a caption
                      depth === 1
                        ? 'mt-4 border-b pb-1 text-sm text-foreground first:mt-0'
                        : depth === 2
                          ? 'mt-3 mb-1 text-xs text-foreground'
                          : 'mt-3 mb-1 text-xs text-muted-foreground'
                    )}
                    title={label}
                  >
                    {label}
                  </Heading>
                )
              })}
              <Card
                className={cn(
                  'cursor-pointer py-0 transition-shadow',
                  indentClass(layout[i].depth),
                  r.id === selectedId && 'ring-2 ring-inset ring-primary'
                )}
                onClick={() => selectResource(r.id)}
              >
                <CardContent className="flex items-center gap-3 px-3 py-[3px]">
                  <FormatBadge
                    format={r.format || '?'}
                    className="inline-flex min-w-[48px] items-center justify-center text-xs"
                  />
                  {/* Two lines' worth of height whatever the name needs — h-9 is
                      two lines at leading-[1.125rem] — so every card is the same
                      height and a one-line name sits centred rather than high */}
                  <div className="flex h-9 min-w-0 flex-1 items-center">
                    {/* Long file names break so they reach the second line
                        rather than being clipped on the first */}
                    <p
                      className="line-clamp-2 text-sm leading-[1.125rem] font-medium break-words"
                      title={r.name || undefined}
                    >
                      {r.name || t('unnamed')}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Fragment>
          ))}
        </div>
      </div>

      {/* Selected resource preview (right) */}
      {selected && (
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {/* Wraps rather than squeezing: below the title's basis the download
              column drops to its own line instead of shaving the name. */}
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
            <h3 className="min-w-0 flex-1 basis-64 text-xl leading-tight font-semibold break-all">
              {selected.name || t('unnamed')}
            </h3>
            <div className="ml-auto flex min-w-0 flex-col items-end gap-1">
              <DownloadButton
                datasetNameOrId={packageName}
                resourceId={selected.id}
                filename={selected.url || selected.id}
                format={selected.format}
                label={t('download')}
                size={selected.size}
              />
              {source && (
                <span className="flex max-w-full flex-wrap items-center justify-end gap-x-1 text-sm text-muted-foreground">
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="shrink-0">{t('externalSource')}</span>
                  {/* URL and warning wrap as one: the icon reads as a mark on
                      the link, not as a line of its own. */}
                  <span className="flex min-w-0 items-center">
                    <a
                      href={source.href}
                      title={source.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-w-0 truncate text-primary underline-offset-4 hover:underline"
                    >
                      {shortenUrl(source)}
                    </a>
                    {linkWarning && <LinkHealthWarning message={linkWarning} />}
                  </span>
                </span>
              )}
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

          {/* Keep visited resources alive: previews avoid iframe re-loading
              (Office Online etc.), version histories keep their fetched rows
              and open state across switches. */}
          {resources
            .filter((r) => visitedIds.has(r.id))
            .map((r) => (
              <div
                key={r.id}
                className={cn('flex flex-col gap-4', r.id !== selectedId && 'hidden')}
              >
                <ResourcePipelinePreview
                  resourceId={r.id}
                  format={r.format}
                  url={externalUrl(r)}
                  size={r.size}
                  canManage={canManage}
                />
                <VersionHistory resourceId={r.id} />
              </div>
            ))}

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
