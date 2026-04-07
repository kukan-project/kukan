'use client'

import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { RefreshCw } from 'lucide-react'
import {
  Badge,
  Button,
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
import { StatCard } from '@/components/dashboard/stat-card'
import { clientFetch } from '@/lib/client-api'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'
import { formatDateTimeCompact } from '@/components/date-time'

type HealthStatsResponse = Record<string, number>

interface HealthItem {
  id: string
  url: string | null
  name: string | null
  healthStatus: string | null
  healthCheckedAt: string | null
  extras: Record<string, unknown> | null
  packageId: string
  packageName: string
  packageTitle: string | null
}

type StatusFilter = 'all' | 'ok' | 'error' | 'unknown'

function healthBadgeVariant(status: string | null) {
  switch (status) {
    case 'ok':
      return 'secondary' as const
    case 'error':
      return 'destructive' as const
    default:
      return 'outline' as const
  }
}

export default function AdminHealthPage() {
  const user = useUser()
  const locale = useLocale()
  const router = useRouter()
  const t = useTranslations('dashboard.adminHealth')
  const tc = useTranslations('common')

  // sysadmin guard
  useEffect(() => {
    if (!user.sysadmin) router.replace('/dashboard')
  }, [user.sysadmin, router])

  // Stats
  const [stats, setStats] = useState<HealthStatsResponse | null>(null)

  const fetchStats = useCallback(async () => {
    const res = await clientFetch('/api/v1/admin/health/stats')
    if (res.ok) setStats(await res.json())
  }, [])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  // Status filter
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const healthUrl = useMemo(
    () =>
      statusFilter === 'all'
        ? '/api/v1/admin/health'
        : `/api/v1/admin/health?status=${statusFilter}`,
    [statusFilter]
  )

  const { items, loading, error, fetchPage, offset, total, pageSize, totalPages, currentPage } =
    usePaginatedFetch<HealthItem>(healthUrl)

  const [refreshing, setRefreshing] = useState(false)
  const offsetRef = useRef(offset)
  useEffect(() => {
    offsetRef.current = offset
  }, [offset])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await Promise.all([fetchPage(offsetRef.current), fetchStats()])
    } finally {
      setRefreshing(false)
    }
  }, [fetchPage, fetchStats])

  const totalAll = stats ? Object.values(stats).reduce((sum, n) => sum + n, 0) : undefined

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

      {/* Stats Cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label={t('statsAll')}
          value={totalAll}
          active={statusFilter === 'all'}
          onClick={() => setStatusFilter('all')}
        />
        <StatCard
          label={t('statsOk')}
          value={stats?.ok}
          active={statusFilter === 'ok'}
          onClick={() => setStatusFilter('ok')}
        />
        <StatCard
          label={t('statsError')}
          value={stats?.error}
          variant="destructive"
          active={statusFilter === 'error'}
          onClick={() => setStatusFilter('error')}
        />
      </div>

      {/* Health Table */}
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
        <p className="py-12 text-center text-muted-foreground">{t('noItems')}</p>
      ) : (
        <>
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[90px]">{t('colStatus')}</TableHead>
                <TableHead className="w-[30%]">
                  <div className="flex flex-col leading-tight">
                    <span className="text-xs font-normal text-muted-foreground">
                      {t('colDataset')}
                    </span>
                    <span>{t('colResource')}</span>
                  </div>
                </TableHead>
                <TableHead className="w-[25%]">{t('colUrl')}</TableHead>
                <TableHead className="w-[120px]">{t('colCheckedAt')}</TableHead>
                <TableHead className="w-[20%]">{t('colError')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const errorMsg = (item.extras?.healthError as string) ?? null
                return (
                  <TableRow key={item.id}>
                    <TableCell>
                      <Badge variant={healthBadgeVariant(item.healthStatus)}>
                        {t(item.healthStatus ?? 'unknown')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <Link
                          href={`/dataset/${item.packageName}`}
                          className="truncate text-xs text-muted-foreground hover:underline"
                        >
                          {item.packageTitle || item.packageName}
                        </Link>
                        <Link
                          href={`/dataset/${item.packageName}/resource/${item.id}`}
                          className="truncate hover:underline"
                        >
                          {item.name || item.id.slice(0, 8)}
                        </Link>
                      </div>
                    </TableCell>
                    <TableCell
                      className="truncate text-sm text-muted-foreground"
                      title={item.url ?? undefined}
                    >
                      {item.url}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {item.healthCheckedAt
                        ? formatDateTimeCompact(item.healthCheckedAt, locale)
                        : '-'}
                    </TableCell>
                    <TableCell className="truncate" title={errorMsg ?? undefined}>
                      {errorMsg && <span className="text-sm text-destructive">{errorMsg}</span>}
                    </TableCell>
                  </TableRow>
                )
              })}
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
