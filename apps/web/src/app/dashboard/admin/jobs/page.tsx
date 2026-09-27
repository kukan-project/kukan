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
import { PaginationControls } from '@/components/dashboard/pagination-controls'
import { StatCard } from '@/components/dashboard/stat-card'
import { clientFetch } from '@/lib/client-api'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'
import { formatDateTimeCompact } from '@/components/date-time'

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
  packageId: string
  packageName: string
  packageTitle: string | null
}

type StatusFilter = 'all' | 'queued' | 'processing' | 'complete' | 'error'

/**
 * How long a reprocessed row is followed. The row may be on another page or
 * hidden by the filter, where its end is never seen; left running, the polls
 * would keep the database awake for as long as the tab stays open.
 */
const POLL_INTERVAL_MS = 3000
const POLL_LIMIT_MS = 5 * 60_000

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

  // Stats
  const [stats, setStats] = useState<JobStatsResponse | null>(null)

  // Never throws: a refresh that fails keeps the counts shown, and must not
  // leave whatever asked for it — the refresh button, a reprocess — stuck
  const fetchStats = useCallback(async () => {
    try {
      const res = await clientFetch('/api/v1/admin/jobs/stats')
      if (res.ok) setStats(await res.json())
    } catch {
      // The cards keep their last counts; the next refresh tries again
    }
  }, [])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  // Status filter
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const jobsUrl = useMemo(
    () =>
      statusFilter === 'all' ? '/api/v1/admin/jobs' : `/api/v1/admin/jobs?status=${statusFilter}`,
    [statusFilter]
  )

  const { items, loading, error, fetchPage, offset, total, pageSize, totalPages, currentPage } =
    usePaginatedFetch<JobItem>(jobsUrl)

  const [refreshing, setRefreshing] = useState(false)
  const [reprocessing, setReprocessing] = useState<string | null>(null)

  // Track current offset for use in callbacks without stale closures
  const offsetRef = useRef(offset)
  useEffect(() => {
    offsetRef.current = offset
  }, [offset])

  const reload = useCallback(
    () => Promise.all([fetchPage(offsetRef.current), fetchStats()]),
    [fetchPage, fetchStats]
  )

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
    setReprocessing(null)
  }, [])

  // Stop polling when job reaches terminal state
  useEffect(() => {
    if (!reprocessing || !pollingRef.current) return
    const job = items.find((j) => j.resourceId === reprocessing)
    if (job && (job.status === 'complete' || job.status === 'error')) {
      stopPolling()
    }
  }, [items, reprocessing, stopPolling])

  // Cleanup on unmount
  useEffect(() => stopPolling, [stopPolling])

  const [reprocessFailed, setReprocessFailed] = useState(false)
  const reprocess = useCallback(
    async (resourceId: string) => {
      stopPolling()
      setReprocessing(resourceId)
      setReprocessFailed(false)
      // A network failure throws rather than answering; either way nothing was
      // queued, and polling for a run that is not coming would never stop
      const res = await clientFetch(`/api/v1/resources/${resourceId}/run-pipeline`, {
        method: 'POST',
      }).catch(() => null)
      if (!res?.ok) {
        setReprocessFailed(true)
        setReprocessing(null)
        return
      }
      const poll = () => reload().catch(() => {})
      await poll()
      const until = Date.now() + POLL_LIMIT_MS
      pollingRef.current = setInterval(() => {
        if (Date.now() > until) stopPolling()
        else void poll()
      }, POLL_INTERVAL_MS)
    },
    [reload, stopPolling]
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

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await reload()
    setRefreshing(false)
  }, [reload])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')}>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={refresh}
          disabled={refreshing}
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
        </Button>
      </PageHeader>

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
                      disabled={reprocessing === job.resourceId}
                      onClick={() => reprocess(job.resourceId)}
                      title={t('reprocess')}
                    >
                      <Play
                        className={`h-3.5 w-3.5 ${reprocessing === job.resourceId ? 'animate-pulse' : ''}`}
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
