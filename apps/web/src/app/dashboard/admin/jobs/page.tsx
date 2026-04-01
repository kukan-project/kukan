'use client'

import { useEffect, useState, useRef, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { RefreshCw } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  Label,
  Switch,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@kukan/ui'
import { useUser } from '@/components/dashboard/user-provider'
import { PageHeader } from '@/components/dashboard/page-header'
import { PaginationControls } from '@/components/dashboard/pagination-controls'
import { clientFetch } from '@/lib/client-api'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'
import { formatDateTimeCompact } from '@/components/date-time'

interface QueueStatsResponse {
  queue: { pending: number; inFlight: number; delayed: number; dlqPending: number }
  jobs: Record<string, number>
  recentErrors: unknown[]
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

const POLL_INTERVAL = 5000

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

  const jobsUrl = useMemo(() => {
    if (statusFilter === 'queued') return '/api/v1/admin/jobs?status=queued'
    if (statusFilter === 'processing') return '/api/v1/admin/jobs?status=processing'
    if (statusFilter === 'complete') return '/api/v1/admin/jobs?status=complete'
    if (statusFilter === 'error') return '/api/v1/admin/jobs?status=error'
    return '/api/v1/admin/jobs'
  }, [statusFilter])

  const { items, loading, error, fetchPage, offset, total, pageSize, totalPages, currentPage } =
    usePaginatedFetch<JobItem>(jobsUrl)

  // Auto-refresh (off by default)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await Promise.all([fetchPage(offset), fetchStats()])
    setRefreshing(false)
  }, [fetchPage, offset, fetchStats])

  useEffect(() => {
    if (!autoRefresh) return
    timeoutRef.current = setTimeout(refresh, POLL_INTERVAL)
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [autoRefresh, items, offset, refresh])

  if (!user.sysadmin) return null

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')}>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={refresh}
            disabled={refreshing}
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
          <div className="flex items-center gap-2">
            <Switch id="auto-refresh" checked={autoRefresh} onCheckedChange={setAutoRefresh} />
            <Label htmlFor="auto-refresh" className="text-sm text-muted-foreground">
              {t('autoRefresh')}
            </Label>
          </div>
        </div>
      </PageHeader>

      {/* Stats Cards (DB-based) */}
      <div className="grid gap-4 sm:grid-cols-5">
        <StatCard
          label={t('statsAll')}
          value={stats ? Object.values(stats.jobs).reduce((sum, n) => sum + n, 0) : undefined}
        />
        <StatCard label={t('statsQueued')} value={stats?.jobs.queued} />
        <StatCard label={t('statsProcessing')} value={stats?.jobs.processing} />
        <StatCard label={t('statsComplete')} value={stats?.jobs.complete} />
        <StatCard label={t('statsError')} value={stats?.jobs.error} variant="destructive" />
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

      {/* Filter Tabs */}
      <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
        <TabsList>
          <TabsTrigger value="all">{t('tabAll')}</TabsTrigger>
          <TabsTrigger value="queued">{t('tabQueued')}</TabsTrigger>
          <TabsTrigger value="processing">{t('tabProcessing')}</TabsTrigger>
          <TabsTrigger value="complete">{t('tabComplete')}</TabsTrigger>
          <TabsTrigger value="error">{t('tabErrors')}</TabsTrigger>
        </TabsList>
      </Tabs>

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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[100px]">{t('colStatus')}</TableHead>
                <TableHead>{t('colDataset')}</TableHead>
                <TableHead>{t('colResource')}</TableHead>
                <TableHead className="w-[140px]">{t('colUpdated')}</TableHead>
                <TableHead>{t('colError')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>
                    <Badge variant={statusBadgeVariant(job.status)}>{t(job.status)}</Badge>
                  </TableCell>
                  <TableCell>
                    <Link href={`/dataset/${job.packageName}`} className="hover:underline">
                      {job.packageTitle || job.packageName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/dataset/${job.packageName}/resource/${job.resourceId}`}
                      className="hover:underline"
                    >
                      {job.resourceName || job.resourceId.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {formatDateTimeCompact(job.updated, locale)}
                  </TableCell>
                  <TableCell>
                    {job.error && (
                      <span className="line-clamp-1 text-sm text-destructive" title={job.error}>
                        {job.error}
                      </span>
                    )}
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
}: {
  label: string
  value?: number
  variant?: 'destructive'
}) {
  return (
    <Card>
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
