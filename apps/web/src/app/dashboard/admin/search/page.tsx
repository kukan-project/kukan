'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Database, RefreshCw, Search, Sparkles } from 'lucide-react'
import { JsonView, collapseAllNested, darkStyles, defaultStyles } from 'react-json-view-lite'
import 'react-json-view-lite/dist/index.css'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@kukan/ui'
import { PageHeader } from '@/components/dashboard/page-header'
import { PaginationControls } from '@/components/dashboard/pagination-controls'
import { FormatBadge } from '@/components/format-badge'
import { clientFetch } from '@/lib/client-api'
import { useVectorSearchSettings } from '@/hooks/use-vector-search-settings'

interface IndexStatsEntry {
  docCount: number
  recentDocs: Array<{ id: string; name?: string; updated?: string }>
}

interface IndexStatsResponse {
  enabled: boolean
  stats: {
    indexName: string
    totalSizeBytes: number
    packages: IndexStatsEntry
    resources: IndexStatsEntry
    contents: IndexStatsEntry
  } | null
  db?: { packages: number; resources: number }
}

interface BrowseItem {
  id: string
  source: Record<string, unknown>
}

interface BrowseResponse {
  items: BrowseItem[]
  total: number
  offset: number
  limit: number
}

interface ContentBrowseItem {
  resourceId: string
  packageId: string
  contentType: string
  chunks: number
  totalSize: number
  resourceName?: string
  resourceFormat?: string
}

interface ContentBrowseResponse {
  items: ContentBrowseItem[]
  total: number
  offset: number
  limit: number
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

type IndexTab = 'packages' | 'resources' | 'contents'

/** Must match apps/worker/src/config.ts MAX_FETCH_SIZE */
const MAX_FETCH_SIZE = 100 * 1024 * 1024

/** Must match apps/worker/src/config.ts MAX_CONTENT_CHUNK_SIZE */
const MAX_CONTENT_CHUNK_SIZE = 500 * 1024

const PAGE_SIZE = 20
const STATS_POLL_COUNT = 20

export default function AdminSearchPage() {
  const t = useTranslations('dashboard.adminSearch')
  const tc = useTranslations('common')

  // Index stats
  const [stats, setStats] = useState<IndexStatsResponse | null>(null)

  const fetchStats = useCallback(async () => {
    try {
      const res = await clientFetch('/api/v1/admin/search/stats')
      if (res.ok) setStats(await res.json())
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  // Tab
  const [activeTab, setActiveTab] = useState<IndexTab>('packages')

  // Browse (packages/resources use BrowseResponse, contents uses ContentBrowseResponse)
  const [browseData, setBrowseData] = useState<BrowseResponse | null>(null)
  const [contentBrowseData, setContentBrowseData] = useState<ContentBrowseResponse | null>(null)
  const [browseLoading, setBrowseLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')

  const fetchBrowse = useCallback(
    async (offset: number, q?: string) => {
      setBrowseLoading(true)
      try {
        const params = new URLSearchParams({ offset: String(offset), limit: String(PAGE_SIZE) })
        if (q) params.set('q', q)
        const res = await clientFetch(`/api/v1/admin/search/browse/${activeTab}?${params}`)
        if (res.ok) {
          const data = await res.json()
          if (activeTab === 'contents') {
            setContentBrowseData(data)
            setBrowseData(null)
          } else {
            setBrowseData(data)
            setContentBrowseData(null)
          }
        }
      } finally {
        setBrowseLoading(false)
      }
    },
    [activeTab]
  )

  // Reset search, refresh stats, and fetch on tab change
  useEffect(() => {
    setSearchQuery('')
    setSubmittedQuery('')
    fetchStats()
    fetchBrowse(0, '')
  }, [activeTab, fetchBrowse, fetchStats])

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    setSubmittedQuery(searchQuery)
    fetchBrowse(0, searchQuery)
  }

  // Document viewer dialog
  const [docDialogOpen, setDocDialogOpen] = useState(false)
  const [docDialogContent, setDocDialogContent] = useState<{
    index: string
    id: string
    body: Record<string, unknown>
  } | null>(null)

  async function showDocument(id: string) {
    const res = await clientFetch(`/api/v1/admin/search/doc/${activeTab}/${id}`)
    if (res.ok) {
      setDocDialogContent({ index: activeTab, id, body: await res.json() })
      setDocDialogOpen(true)
    }
  }

  // Reindex
  // Contents tree view: expanded resource → chunk list
  const [expandedResourceId, setExpandedResourceId] = useState<string | null>(null)
  const [expandedChunks, setExpandedChunks] = useState<
    Array<{ id: string; chunkIndex: number; chunkSize: number }>
  >([])

  async function toggleResourceExpand(resourceId: string) {
    if (expandedResourceId === resourceId) {
      setExpandedResourceId(null)
      setExpandedChunks([])
      return
    }
    setExpandedResourceId(resourceId)
    const res = await clientFetch(`/api/v1/admin/search/chunks/${resourceId}`)
    if (res.ok) {
      const data = await res.json()
      setExpandedChunks(data.items)
    }
  }

  // The three reprocess actions, one at a time. Each names what it rebuilds
  // and whether it fetches anything; the content one is the heavy one.
  type ReprocessAction = 'index' | 'content' | 'embed'
  const [busy, setBusy] = useState<ReprocessAction | null>(null)
  const [outcome, setOutcome] = useState<{ action: ReprocessAction; ok: boolean } | null>(null)
  const vectorSettings = useVectorSearchSettings()
  const embedModel = vectorSettings.data?.model ?? null
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (pollingRef.current) clearInterval(pollingRef.current)
    pollingRef.current = null
  }, [])

  // Cleanup polling on unmount
  useEffect(() => stopPolling, [stopPolling])

  async function reprocess(action: ReprocessAction) {
    setBusy(action)
    setOutcome(null)
    try {
      const res =
        action === 'embed'
          ? await clientFetch('/api/v1/admin/reindex-embeddings', { method: 'POST' })
          : await clientFetch('/api/v1/admin/reindex-metadata', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ includeContent: action === 'content' }),
            })
      setOutcome({ action, ok: res.ok })
      if (res.ok && action !== 'embed') pollStats()
    } catch {
      setOutcome({ action, ok: false })
    } finally {
      setBusy(null)
    }
  }

  // Poll stats so the index cards update live while Worker processes
  function pollStats() {
    stopPolling()
    let pollCount = 0
    pollingRef.current = setInterval(async () => {
      pollCount++
      if (pollCount >= STATS_POLL_COUNT) {
        stopPolling()
        fetchBrowse(0, submittedQuery)
        return
      }
      try {
        const statsRes = await clientFetch('/api/v1/admin/search/stats')
        if (!statsRes.ok) return
        const latest: IndexStatsResponse = await statsRes.json()

        setStats((prev) => {
          if (
            prev?.stats?.packages.docCount === latest.stats?.packages.docCount &&
            prev?.stats?.resources.docCount === latest.stats?.resources.docCount
          ) {
            return prev
          }
          return latest
        })
      } catch {
        // ignore transient errors
      }
    }, 3000)
  }

  const activeBrowse = activeTab === 'contents' ? contentBrowseData : browseData
  const totalPages = activeBrowse ? Math.ceil(activeBrowse.total / PAGE_SIZE) : 0
  const currentPage = activeBrowse ? Math.floor(activeBrowse.offset / PAGE_SIZE) + 1 : 1

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} />

      {/* Index Stats */}
      {stats?.stats && (
        <>
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{stats.stats.indexName}</span>
            <Badge variant="outline" className="text-xs">
              {formatBytes(stats.stats.totalSizeBytes)}
            </Badge>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {(['packages', 'resources', 'contents'] as const).map((idx) => {
              const entry = stats.stats![idx]
              return (
                <Card
                  key={idx}
                  className={`cursor-pointer transition-colors ${activeTab === idx ? 'border-primary' : ''}`}
                  onClick={() => setActiveTab(idx)}
                >
                  <CardContent className="flex items-center gap-3 p-4">
                    <Database className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{idx}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('indexStatsDocs', { count: entry.docCount })}
                      </p>
                    </div>
                    {activeTab === idx && (
                      <Badge variant="secondary" className="ml-auto text-xs">
                        {t('selected')}
                      </Badge>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </>
      )}

      {/* Document Browser */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              {activeTab}
              {activeBrowse && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  ({tc('count', { count: activeBrowse.total })})
                </span>
              )}
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Search */}
          <form onSubmit={handleSearch} className="flex gap-2">
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className="max-w-sm"
            />
            <Button type="submit" variant="outline" size="sm">
              <Search className="mr-1 h-3.5 w-3.5" />
              {t('search')}
            </Button>
          </form>

          {/* Table */}
          {browseLoading && !activeBrowse ? (
            <p className="py-8 text-center text-muted-foreground">{tc('loading')}</p>
          ) : activeBrowse && activeBrowse.items.length > 0 ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className={activeTab === 'contents' ? '' : 'w-[280px]'}>
                      ID
                    </TableHead>
                    {activeTab === 'contents' && <TableHead>{t('colName')}</TableHead>}
                    {activeTab === 'packages' && <TableHead>{t('colTitle')}</TableHead>}
                    {activeTab === 'resources' && <TableHead>{t('colName')}</TableHead>}
                    {activeTab === 'resources' && (
                      <TableHead className="w-[100px]">{t('colFormat')}</TableHead>
                    )}
                    {activeTab === 'contents' && (
                      <TableHead className="w-[80px]">{t('colContentType')}</TableHead>
                    )}
                    {activeTab === 'contents' && <TableHead className="w-[80px]">Chunks</TableHead>}
                    {activeTab === 'contents' && (
                      <TableHead className="w-[100px]">{t('colSize')}</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeTab === 'contents' && contentBrowseData
                    ? contentBrowseData.items.map((item) => (
                        <React.Fragment key={item.resourceId}>
                          <TableRow
                            className="cursor-pointer hover:bg-accent/50"
                            onClick={() => toggleResourceExpand(item.resourceId)}
                          >
                            <TableCell className="whitespace-nowrap font-mono text-xs">
                              <span className="mr-1">
                                {expandedResourceId === item.resourceId ? '▼' : '▶'}
                              </span>
                              {item.resourceId}
                            </TableCell>
                            <TableCell className="text-xs">{item.resourceName ?? '-'}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-xs">
                                {item.contentType}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-center text-xs text-muted-foreground">
                              {item.chunks}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              <div className="flex items-center gap-1.5">
                                <div className="h-2 w-16 rounded-full bg-muted">
                                  <div
                                    className="h-2 rounded-full bg-primary/60"
                                    style={{
                                      width: `${Math.min((item.totalSize / MAX_FETCH_SIZE) * 100, 100)}%`,
                                    }}
                                  />
                                </div>
                                <span className="whitespace-nowrap">
                                  {formatBytes(item.totalSize)}
                                </span>
                              </div>
                            </TableCell>
                          </TableRow>
                          {expandedResourceId === item.resourceId &&
                            expandedChunks.map((chunk) => (
                              <TableRow
                                key={chunk.id}
                                className="cursor-pointer bg-muted/30 hover:bg-accent/50"
                                onClick={() => showDocument(chunk.id)}
                              >
                                <TableCell className="whitespace-nowrap pl-8 font-mono text-xs text-muted-foreground">
                                  {chunk.id}
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                  chunk #{chunk.chunkIndex}
                                </TableCell>
                                <TableCell />
                                <TableCell />
                                <TableCell className="text-xs text-muted-foreground">
                                  <div className="flex items-center gap-1.5">
                                    <div className="h-2 w-16 rounded-full bg-muted">
                                      <div
                                        className="h-2 rounded-full bg-muted-foreground/40"
                                        style={{
                                          width: `${Math.min((chunk.chunkSize / MAX_CONTENT_CHUNK_SIZE) * 100, 100)}%`,
                                        }}
                                      />
                                    </div>
                                    <span className="whitespace-nowrap">
                                      {formatBytes(chunk.chunkSize)}
                                    </span>
                                  </div>
                                </TableCell>
                              </TableRow>
                            ))}
                        </React.Fragment>
                      ))
                    : browseData?.items.map((item) => (
                        <TableRow
                          key={item.id}
                          className="cursor-pointer hover:bg-accent/50"
                          onClick={() => showDocument(item.id)}
                        >
                          <TableCell className="whitespace-nowrap font-mono text-xs">
                            {item.id}
                          </TableCell>
                          {activeTab === 'packages' && (
                            <TableCell>
                              {(item.source.title as string) ?? (item.source.name as string) ?? '-'}
                            </TableCell>
                          )}
                          {activeTab === 'resources' && (
                            <TableCell>{(item.source.name as string) ?? '-'}</TableCell>
                          )}
                          {activeTab === 'resources' && (
                            <TableCell>
                              {typeof item.source.format === 'string' && (
                                <FormatBadge format={item.source.format} />
                              )}
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                </TableBody>
              </Table>
              <PaginationControls
                offset={activeBrowse!.offset}
                total={activeBrowse!.total}
                pageSize={PAGE_SIZE}
                totalPages={totalPages}
                currentPage={currentPage}
                onPageChange={(offset) => fetchBrowse(offset, submittedQuery)}
              />
            </>
          ) : (
            <p className="py-8 text-center text-muted-foreground">{t('noDocuments')}</p>
          )}
        </CardContent>
      </Card>

      {/* Reprocess — what each action rebuilds, and whether it fetches */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('reprocessTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col divide-y">
          {(
            [
              { action: 'index', icon: Search, enabled: true },
              { action: 'content', icon: RefreshCw, enabled: true },
              { action: 'embed', icon: Sparkles, enabled: embedModel !== null },
            ] as const
          ).map(({ action, icon: Icon, enabled }) => (
            <div key={action} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
              <p className="text-sm font-medium">{t(`${action}Title`)}</p>
              <p className="text-sm text-muted-foreground">{t(`${action}Description`)}</p>
              {action === 'embed' && embedModel && (
                <p className="text-sm">
                  <span className="text-muted-foreground">{t('embedModel')}: </span>
                  <span className="font-mono text-xs">{embedModel}</span>
                </p>
              )}
              {action === 'embed' && vectorSettings.error && (
                <p role="alert" className="text-sm text-destructive">
                  {t('settingsUnavailable')}
                </p>
              )}
              {action === 'embed' &&
                !vectorSettings.loading &&
                !vectorSettings.error &&
                !embedModel && (
                  <p className="text-sm text-muted-foreground">{t('embedUnavailable')}</p>
                )}
              <div className="flex items-center gap-4">
                <Button
                  variant="outline"
                  onClick={() => reprocess(action)}
                  disabled={!enabled || busy !== null}
                >
                  <Icon className={`mr-2 h-4 w-4 ${busy === action ? 'animate-spin' : ''}`} />
                  {busy === action ? t('queueing') : t(`${action}Button`)}
                </Button>
                {outcome?.action === action && outcome.ok && (
                  <p role="status" className="text-sm text-muted-foreground">
                    {t(`${action}Queued`)}
                  </p>
                )}
                {outcome?.action === action && !outcome.ok && (
                  <p role="alert" className="text-sm text-destructive">
                    {t('queueFailed')}
                  </p>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Document Viewer Dialog */}
      <Dialog open={docDialogOpen} onOpenChange={setDocDialogOpen}>
        <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">
              {docDialogContent?.index} / {docDialogContent?.id}
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto rounded-md bg-muted p-4 text-xs">
            {docDialogContent && (
              <JsonView
                data={docDialogContent.body}
                shouldExpandNode={collapseAllNested}
                style={
                  typeof window !== 'undefined' &&
                  document.documentElement.classList.contains('dark')
                    ? darkStyles
                    : defaultStyles
                }
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
