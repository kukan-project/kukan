'use client'

import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
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
import { useUser } from '@/components/dashboard/user-provider'
import { PageHeader } from '@/components/dashboard/page-header'
import { PaginationControls } from '@/components/dashboard/pagination-controls'
import { clientFetch } from '@/lib/client-api'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'
import { formatDateTimeCompact } from '@/components/date-time'

interface QueueStatsResponse {
  queue: { pending: number; inFlight: number; delayed: number }
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
  const user = useUser()
  const locale = useLocale()
  const router = useRouter()
  const t = useTranslations('dashboard.adminJobs')
  const tc = useTranslations('common')

  // sysadmin guard
  useEffect(() => {
    if (!user.sysadmin) router.replace('/dashboard')
  }, [user.sysadmin, router])

  // Stats
  const [stats, setStats] = useState<QueueStatsResponse | null>(null)

  const fetchStats = useCallback(async () => {
    const res = await clientFetch('/api/v1/admin/jobs/stats')
    if (res.ok) setStats(await res.json())
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

  const reprocess = useCallback(
    async (resourceId: string) => {
      stopPolling()
      setReprocessing(resourceId)
      await clientFetch(`/api/v1/resources/${resourceId}/run-pipeline`, { method: 'POST' })
      await Promise.all([fetchPage(offsetRef.current), fetchStats()])
      pollingRef.current = setInterval(async () => {
        await Promise.all([fetchPage(offsetRef.current), fetchStats()])
      }, 3000)
    },
    [fetchPage, fetchStats, stopPolling]
  )

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await Promise.all([fetchPage(offsetRef.current), fetchStats()])
    setRefreshing(false)
  }, [fetchPage, fetchStats])

  if (!user.sysadmin) return null

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

      {/* SQS Queue Info (reference) */}
      {stats && (
        <p className="text-xs text-muted-foreground">
          {t('sqsInfo', {
            pending: stats.queue.pending,
            inFlight: stats.queue.inFlight,
          })}
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

function StatCard({
  label,
  value,
  variant,
  active,
  onClick,
}: {
  label: string
  value?: number
  variant?: 'destructive'
  active?: boolean
  onClick?: () => void
}) {
  return (
    <Card
      className={`cursor-pointer transition-colors hover:border-primary/50 ${active ? 'border-primary bg-primary/5 ring-2 ring-primary/25' : ''}`}
      onClick={onClick}
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p
          className={`text-3xl font-bold ${variant === 'destructive' && value ? 'text-destructive' : ''}`}
        >
          {value ?? '-'}
        </p>
      </CardContent>
    </Card>
  )
}
