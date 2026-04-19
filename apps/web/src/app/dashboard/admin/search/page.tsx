'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Database, Search } from 'lucide-react'
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
import { useUser } from '@/components/dashboard/user-provider'
import { PageHeader } from '@/components/dashboard/page-header'
import { PaginationControls } from '@/components/dashboard/pagination-controls'
import { FormatBadge } from '@/components/format-badge'
import { clientFetch } from '@/lib/client-api'

interface IndexStatsEntry {
  docCount: number
  sizeBytes: number
  recentDocs: Array<{ id: string; name?: string; updated?: string }>
}

interface IndexStatsResponse {
  enabled: boolean
  stats: { packages: IndexStatsEntry; resources: IndexStatsEntry; contents: IndexStatsEntry } | null
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

type IndexTab = 'packages' | 'resources' | 'contents'

const PAGE_SIZE = 20

export default function AdminSearchPage() {
  const user = useUser()
  const router = useRouter()
  const t = useTranslations('dashboard.adminSearch')
  const tc = useTranslations('common')

  useEffect(() => {
    if (!user.sysadmin) router.replace('/dashboard')
  }, [user.sysadmin, router])

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

  // Browse
  const [browseData, setBrowseData] = useState<BrowseResponse | null>(null)
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
        if (res.ok) setBrowseData(await res.json())
      } finally {
        setBrowseLoading(false)
      }
    },
    [activeTab]
  )

  // Reset search and fetch on tab change
  useEffect(() => {
    setSearchQuery('')
    setSubmittedQuery('')
    fetchBrowse(0, '')
  }, [activeTab, fetchBrowse])

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
  const [reindexing, setReindexing] = useState(false)
  const [includeContent, setIncludeContent] = useState(false)
  const [reindexResult, setReindexResult] = useState<{
    indexed: number
    resourcesIndexed: number
    contentEnqueued?: number
  } | null>(null)

  async function handleReindex() {
    setReindexing(true)
    setReindexResult(null)
    try {
      const res = await clientFetch('/api/v1/admin/reindex', { method: 'POST' })
      if (!res.ok) return
      const data = await res.json()

      if (includeContent) {
        const enqueueRes = await clientFetch('/api/v1/admin/jobs/enqueue-all', { method: 'POST' })
        if (enqueueRes.ok) {
          const enqueueData = await enqueueRes.json()
          setReindexResult({ ...data, contentEnqueued: enqueueData.enqueued })
        } else {
          setReindexResult(data)
        }
      } else {
        setReindexResult(data)
      }
    } finally {
      setReindexing(false)
      await Promise.all([fetchStats(), fetchBrowse(0, submittedQuery)])
    }
  }

  if (!user.sysadmin) return null

  const totalPages = browseData ? Math.ceil(browseData.total / PAGE_SIZE) : 0
  const currentPage = browseData ? Math.floor(browseData.offset / PAGE_SIZE) + 1 : 1

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} />

      {/* Index Stats */}
      {stats?.stats && (
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
                    <p className="text-sm font-medium">kukan-{idx}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('indexStatsDocs', { count: entry.docCount })}
                      {' / '}
                      {formatBytes(entry.sizeBytes)}
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
      )}

      {/* Document Browser */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              kukan-{activeTab}
              {browseData && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  ({tc('count', { count: browseData.total })})
                </span>
              )}
            </CardTitle>
            {activeTab === 'resources' && (
              <p className="text-xs text-muted-foreground">{t('contentSizeNote')}</p>
            )}
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
          {browseLoading && !browseData ? (
            <p className="py-8 text-center text-muted-foreground">{tc('loading')}</p>
          ) : browseData && browseData.items.length > 0 ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[280px]">ID</TableHead>
                    <TableHead>{activeTab === 'packages' ? t('colTitle') : t('colName')}</TableHead>
                    {activeTab === 'resources' && (
                      <TableHead className="w-[100px]">{t('colFormat')}</TableHead>
                    )}
                    {activeTab === 'resources' && (
                      <TableHead className="w-[100px]">{t('colContent')}</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {browseData.items.map((item) => (
                    <TableRow
                      key={item.id}
                      className="cursor-pointer hover:bg-accent/50"
                      onClick={() => showDocument(item.id)}
                    >
                      <TableCell className="whitespace-nowrap font-mono text-xs">
                        {item.id}
                      </TableCell>
                      <TableCell>
                        {activeTab === 'packages'
                          ? ((item.source.title as string) ?? (item.source.name as string) ?? '-')
                          : ((item.source.name as string) ?? '-')}
                      </TableCell>
                      {activeTab === 'resources' && (
                        <TableCell>
                          {typeof item.source.format === 'string' && (
                            <FormatBadge format={item.source.format} />
                          )}
                        </TableCell>
                      )}
                      {activeTab === 'resources' && (
                        <TableCell className="whitespace-nowrap">
                          {item.source.contentType ? (
                            <span className="flex items-center gap-1">
                              {typeof item.source.contentTruncated === 'boolean' && (
                                <Badge
                                  variant={
                                    item.source.contentTruncated ? 'destructive' : 'secondary'
                                  }
                                  className="text-xs"
                                >
                                  {item.source.contentTruncated ? t('truncated') : t('full')}
                                </Badge>
                              )}
                              {typeof item.source.contentOriginalSize === 'number' && (
                                <span className="text-[10px] text-muted-foreground">
                                  {formatBytes(item.source.contentOriginalSize as number)}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">-</span>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <PaginationControls
                offset={browseData.offset}
                total={browseData.total}
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

      {/* Rebuild */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('reindexTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">{t('reindexDescription')}</p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeContent}
              onChange={(e) => setIncludeContent(e.target.checked)}
              disabled={reindexing}
              className="rounded border-input"
            />
            {t('includeContent')}
          </label>
          <div className="flex items-center gap-4">
            <Button onClick={handleReindex} disabled={reindexing}>
              <Search className="mr-2 h-4 w-4" />
              {reindexing ? t('reindexing') : t('reindex')}
            </Button>
            {reindexResult !== null && (
              <div className="text-sm text-muted-foreground">
                <p>
                  {t('reindexResult', {
                    count: reindexResult.indexed,
                    resourceCount: reindexResult.resourcesIndexed,
                  })}
                </p>
                {reindexResult.contentEnqueued !== undefined && (
                  <p>{t('contentEnqueuedResult', { count: reindexResult.contentEnqueued })}</p>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Document Viewer Dialog */}
      <Dialog open={docDialogOpen} onOpenChange={setDocDialogOpen}>
        <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">
              kukan-{docDialogContent?.index} / {docDialogContent?.id}
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
