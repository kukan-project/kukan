'use client'

import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Play, RefreshCw } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@kukan/ui'
import { PageHeader } from '@/components/dashboard/page-header'
import { RefreshButton } from '@/components/dashboard/refresh-button'
import { PaginationControls } from '@/components/dashboard/pagination-controls'
import { StatCard } from '@/components/dashboard/stat-card'
import { clientFetch } from '@/lib/client-api'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'
import { useAutoRefresh } from '@/hooks/use-auto-refresh'
import { useLatestJson } from '@/hooks/use-latest-json'
import { formatDateTimeCompact } from '@/components/date-time'
import { formatBytes } from '@/lib/format-utils'

interface JobStatsResponse {
  jobs: Record<string, number>
}

interface JobItem {
  id: string
  resourceId: string
  status: string
  error: string | null
  created: string
  updated: string
  resourceName: string | null
  resourceSize: number | null
  packageId: string
  packageName: string
  packageTitle: string | null
}

type StatusFilter = 'all' | 'queued' | 'processing' | 'complete' | 'error'

/**
 * How long a reprocessed row is marked as running. The row may be on another
 * page or hidden by the filter, where its end is never seen.
 */
const REPROCESS_MARK_MS = 5 * 60_000

function statusBadgeVariant(status: string) {
  switch (status) {
    case 'processing':
      return 'default' as const
    case 'queued':
      return 'secondary' as const
    case 'error':
      return 'destructive' as const
    default:
      return 'outline' as const
  }
}

export default function AdminJobsPage() {
  const locale = useLocale()
  const t = useTranslations('dashboard.adminJobs')
  const tc = useTranslations('common')

  const { data: stats, fetch: fetchStats } = useLatestJson<JobStatsResponse>(
    '/api/v1/admin/jobs/stats'
  )

  // Status filter
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const jobsUrl = useMemo(
    () =>
      statusFilter === 'all' ? '/api/v1/admin/jobs' : `/api/v1/admin/jobs?status=${statusFilter}`,
    [statusFilter]
  )

  const {
    items,
    loading,
    error,
    fetchPage,
    refresh: refreshPage,
    offset,
    total,
    pageSize,
    totalPages,
    currentPage,
  } = usePaginatedFetch<JobItem>(jobsUrl)

  // The row reprocessed, and when it last changed before the press: its old
  // complete or error is still on screen until the next fetch, and must not
  // count as the new run's end
  const [reprocessing, setReprocessing] = useState<{ resourceId: string; since: string } | null>(
    null
  )

  const reload = useCallback(
    () => Promise.all([fetchPage(offset), fetchStats()]),
    [fetchPage, fetchStats, offset]
  )

  const { spinning, refreshing, refresh } = useAutoRefresh({
    poll: () => Promise.all([refreshPage(), fetchStats()]),
    reload,
  })

  // A reprocessed row is marked until the polls show it done, or for a while
  const markTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearMark = useCallback(() => {
    if (markTimer.current) clearTimeout(markTimer.current)
    markTimer.current = null
    setReprocessing(null)
  }, [])

  useEffect(() => {
    if (!reprocessing) return
    const job = items.find((j) => j.resourceId === reprocessing.resourceId)
    if (!job || job.updated === reprocessing.since) return
    if (job.status === 'complete' || job.status === 'error') clearMark()
  }, [items, reprocessing, clearMark])

  useEffect(() => clearMark, [clearMark])

  const [reprocessFailed, setReprocessFailed] = useState(false)
  const reprocess = useCallback(
    async ({ resourceId, updated }: JobItem) => {
      clearMark()
      setReprocessing({ resourceId, since: updated })
      setReprocessFailed(false)
      // A network failure throws rather than answering; either way nothing was
      // queued, and the row must not stay marked for a run that is not coming
      const res = await clientFetch(`/api/v1/resources/${resourceId}/run-pipeline`, {
        method: 'POST',
      }).catch(() => null)
      if (!res?.ok) {
        setReprocessFailed(true)
        setReprocessing(null)
        return
      }
      await reload().catch(() => {})
      markTimer.current = setTimeout(clearMark, REPROCESS_MARK_MS)
    },
    [reload, clearMark]
  )

  // Every resource's pipeline again, from the file it holds — the runs this
  // page then follows (ADR-044 §4)
  const [contentBusy, setContentBusy] = useState(false)
  const [contentOutcome, setContentOutcome] = useState<boolean | null>(null)
  const reprocessContent = useCallback(async () => {
    setContentBusy(true)
    setContentOutcome(null)
    try {
      const res = await clientFetch('/api/v1/admin/reindex-metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeContent: true }),
      })
      setContentOutcome(res.ok)
      if (res.ok) await reload()
    } catch {
      setContentOutcome(false)
    } finally {
      setContentBusy(false)
    }
  }, [reload])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')}>
        <RefreshButton onClick={refresh} disabled={refreshing} spinning={spinning} />
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('contentTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">{t('contentDescription')}</p>
          <div className="flex items-center gap-4">
            <Button variant="outline" onClick={reprocessContent} disabled={contentBusy}>
              <RefreshCw className={`mr-2 h-4 w-4 ${contentBusy ? 'animate-spin' : ''}`} />
              {contentBusy ? tc('queueing') : t('contentButton')}
            </Button>
            {contentOutcome === true && (
              <p role="status" className="text-sm text-muted-foreground">
                {t('contentQueued')}
              </p>
            )}
            {contentOutcome === false && (
              <p role="alert" className="text-sm text-destructive">
                {tc('queueFailed')}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Stats Cards (DB-based) */}
      <div className="grid gap-4 sm:grid-cols-5">
        <StatCard
          label={t('statsAll')}
          value={stats ? Object.values(stats.jobs).reduce((sum, n) => sum + n, 0) : undefined}
          active={statusFilter === 'all'}
          onClick={() => setStatusFilter('all')}
        />
        <StatCard
          label={t('statsQueued')}
          value={stats?.jobs.queued}
          active={statusFilter === 'queued'}
          onClick={() => setStatusFilter('queued')}
        />
        <StatCard
          label={t('statsProcessing')}
          value={stats?.jobs.processing}
          active={statusFilter === 'processing'}
          onClick={() => setStatusFilter('processing')}
        />
        <StatCard
          label={t('statsComplete')}
          value={stats?.jobs.complete}
          active={statusFilter === 'complete'}
          onClick={() => setStatusFilter('complete')}
        />
        <StatCard
          label={t('statsError')}
          value={stats?.jobs.error}
          variant="destructive"
          active={statusFilter === 'error'}
          onClick={() => setStatusFilter('error')}
        />
      </div>

      {reprocessFailed && (
        <p role="alert" className="text-sm text-destructive">
          {tc('queueFailed')}
        </p>
      )}

      {/* Jobs Table */}
      {loading && !items.length ? (
        <p className="py-12 text-center text-muted-foreground">{tc('loading')}</p>
      ) : error ? (
        <div className="flex flex-col items-center gap-2 py-12">
          <p className="text-muted-foreground">{tc('fetchError')}</p>
          <Button variant="outline" size="sm" onClick={() => fetchPage(offset)}>
            {tc('retry')}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">{t('noJobs')}</p>
      ) : (
        <>
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[90px]">{t('colStatus')}</TableHead>
                <TableHead className="w-[40%]">
                  <div className="flex flex-col leading-tight">
                    <span className="text-xs font-normal text-muted-foreground">
                      {t('colDataset')}
                    </span>
                    <span>{t('colResource')}</span>
                  </div>
                </TableHead>
                <TableHead className="w-[90px] text-right">{t('colSize')}</TableHead>
                <TableHead className="w-[120px]">{t('colUpdated')}</TableHead>
                <TableHead className="w-[15%]">{t('colError')}</TableHead>
                <TableHead className="w-[72px]">{t('reprocess')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>
                    <Badge variant={statusBadgeVariant(job.status)}>{t(job.status)}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <Link
                        href={`/dataset/${job.packageName}`}
                        className="truncate text-xs text-muted-foreground hover:underline"
                      >
                        {job.packageTitle || job.packageName}
                      </Link>
                      <Link
                        href={`/dataset/${job.packageName}/resource/${job.resourceId}`}
                        className="truncate hover:underline"
                      >
                        {job.resourceName || job.resourceId.slice(0, 8)}
                      </Link>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right text-sm tabular-nums text-muted-foreground">
                    {formatBytes(job.resourceSize) ?? '—'}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {formatDateTimeCompact(job.updated, locale)}
                  </TableCell>
                  <TableCell className="truncate" title={job.error ?? undefined}>
                    {job.error && <span className="text-sm text-destructive">{job.error}</span>}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={reprocessing?.resourceId === job.resourceId}
                      onClick={() => reprocess(job)}
                      title={t('reprocess')}
                    >
                      <Play
                        className={`h-3.5 w-3.5 ${reprocessing?.resourceId === job.resourceId ? 'animate-pulse' : ''}`}
                      />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PaginationControls
            offset={offset}
            total={total}
            pageSize={pageSize}
            totalPages={totalPages}
            currentPage={currentPage}
            onPageChange={fetchPage}
          />
        </>
      )}
    </div>
  )
}
