'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
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
import { PageHeader } from '@/components/dashboard/page-header'
import { PaginationControls } from '@/components/dashboard/pagination-controls'
import { DeleteConfirmDialog } from '@/components/dashboard/delete-confirm-dialog'
import { clientFetch } from '@/lib/client-api'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'
import { formatDateTimeCompact } from '@/components/date-time'
import {
  BACKFILL_VERSIONS_JOB_TYPE,
  CONVERT_SET_ASIDE_JOB_TYPE,
  EMBED_JOB_TYPE,
  JOB_STATUSES,
  LAKE_INGEST_JOB_TYPE,
  PIPELINE_JOB_TYPE,
  PURGE_ORG_JOB_TYPE,
  PURGE_VERSION_JOB_TYPE,
  REANALYSE_INDEX_JOB_TYPE,
  RECORD_ROW_GROUPS_JOB_TYPE,
  REINDEX_JOB_TYPE,
  SUMMARIZE_ALL_JOB_TYPE,
  SUMMARIZE_PACKAGE_JOB_TYPE,
  SYNC_RESOURCE_DOC_JOB_TYPE,
  type JobStatus,
} from '@kukan/shared'

interface JobCount {
  type: string
  status: JobStatus
  count: number
}

/** Every job type, in the order they matter day to day; one not listed goes last. */
const TYPE_ORDER: string[] = [
  PIPELINE_JOB_TYPE,
  SYNC_RESOURCE_DOC_JOB_TYPE,
  LAKE_INGEST_JOB_TYPE,
  EMBED_JOB_TYPE,
  SUMMARIZE_PACKAGE_JOB_TYPE,
  SUMMARIZE_ALL_JOB_TYPE,
  REINDEX_JOB_TYPE,
  REANALYSE_INDEX_JOB_TYPE,
  PURGE_VERSION_JOB_TYPE,
  PURGE_ORG_JOB_TYPE,
  BACKFILL_VERSIONS_JOB_TYPE,
  CONVERT_SET_ASIDE_JOB_TYPE,
  RECORD_ROW_GROUPS_JOB_TYPE,
]

/** Where there are jobs, in the accent; dead ones in red; empty cells recede. */
function cellTone(status: JobStatus, value: number): string {
  if (value === 0) return 'text-muted-foreground'
  return status === 'dead' ? 'font-semibold text-destructive' : 'font-semibold text-primary'
}

function typeRank(type: string): number {
  const i = TYPE_ORDER.indexOf(type)
  return i === -1 ? TYPE_ORDER.length : i
}

interface JobItem {
  id: string
  type: string
  payload: unknown
  status: JobStatus
  attempts: number
  lastError: string | null
  updated: string
}

function statusBadgeVariant(status: JobStatus) {
  switch (status) {
    case 'running':
      return 'default' as const
    case 'dead':
      return 'destructive' as const
    case 'waiting':
      return 'secondary' as const
    default:
      return 'outline' as const
  }
}

/** What a job is about, from its payload: `resourceId=…, version=2`. */
function describeTarget(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  return Object.entries(payload as Record<string, unknown>)
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(', ')
}

/**
 * The job table itself (ADR-058): every job the worker runs, of any type. The
 * resource processing page shows where each resource's pipeline stands; this
 * shows what is queued behind it — and the jobs that gave up, which nothing
 * else surfaces.
 */
export default function AdminQueuePage() {
  const locale = useLocale()
  const t = useTranslations('dashboard.adminQueue')
  const tc = useTranslations('common')

  const [counts, setCounts] = useState<JobCount[] | null>(null)
  // Never throws: a refresh that fails keeps the counts shown, and must not
  // cut short whatever asked for it — a delete's dialog closing, say
  const fetchCounts = useCallback(async () => {
    try {
      const res = await clientFetch('/api/v1/admin/queue/counts')
      if (res.ok) setCounts((await res.json()).items)
    } catch {
      // The table keeps its last counts; the next refresh tries again
    }
  }, [])
  useEffect(() => {
    fetchCounts()
  }, [fetchCounts])

  // What the worker is on now, of every type; dead jobs show as red counts
  const [filter, setFilter] = useState<{ status: JobStatus; type?: string }>({
    status: 'running',
  })
  const jobsUrl = useMemo(() => {
    const params = new URLSearchParams({ status: filter.status })
    if (filter.type) params.set('type', filter.type)
    return `/api/v1/admin/queue/jobs?${params}`
  }, [filter])
  const { items, loading, error, fetchPage, offset, total, pageSize, totalPages, currentPage } =
    usePaginatedFetch<JobItem>(jobsUrl)

  // The last row of the last page retried or deleted leaves that page empty;
  // step back to the page that now ends the list
  useEffect(() => {
    if (!loading && items.length === 0 && total > 0 && offset >= total) {
      fetchPage(Math.floor((total - 1) / pageSize) * pageSize)
    }
  }, [loading, items.length, total, offset, pageSize, fetchPage])

  const [refreshing, setRefreshing] = useState(false)
  const [acting, setActing] = useState<string | null>(null)
  const [actionFailed, setActionFailed] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const reload = useCallback(
    () => Promise.all([fetchPage(offset), fetchCounts()]),
    [fetchPage, fetchCounts, offset]
  )

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await reload()
    setRefreshing(false)
  }, [reload])

  const act = useCallback(
    async (id: string, request: () => Promise<Response>) => {
      setActing(id)
      setActionFailed(false)
      try {
        // A network failure throws rather than answering; either way it failed
        const res = await request().catch(() => null)
        if (!res?.ok) setActionFailed(true)
        await reload()
      } finally {
        // Released however it went, or the row's buttons stay disabled
        setActing(null)
      }
    },
    [reload]
  )

  const retry = (id: string) =>
    act(id, () => clientFetch(`/api/v1/admin/queue/jobs/${id}/retry`, { method: 'POST' }))

  const confirmDelete = async () => {
    if (!deleteTarget) return
    await act(deleteTarget, () =>
      clientFetch(`/api/v1/admin/queue/jobs/${deleteTarget}`, { method: 'DELETE' })
    )
    setDeleteTarget(null)
  }

  // Type × status. Every known type has a row, empty or not, so the table also
  // says what kinds of job there are; an unknown one that has jobs follows
  const countOf = (type: string | undefined, status: JobStatus) =>
    (counts ?? [])
      .filter((c) => c.status === status && (type === undefined || c.type === type))
      .reduce((sum, c) => sum + c.count, 0)
  const types = [...new Set([...TYPE_ORDER, ...(counts ?? []).map((c) => c.type)])].sort(
    (a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b)
  )
  const typeLabel = (type: string) => (t.has(`types.${type}`) ? t(`types.${type}`) : type)

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
      <p className="-mt-3 text-sm text-muted-foreground">{t('description')}</p>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('colJobType')}</TableHead>
            {JOB_STATUSES.map((status) => (
              <TableHead key={status} className="w-[100px] text-right">
                {t(status)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {[
            ...types.map((type) => ({ type, label: typeLabel(type) })),
            { type: undefined, label: t('total') },
          ].map((row) => (
            <TableRow key={row.type ?? 'total'} className={row.type ? undefined : 'font-semibold'}>
              <TableCell>{row.label}</TableCell>
              {JOB_STATUSES.map((status) => {
                const value = countOf(row.type, status)
                const active = filter.status === status && filter.type === row.type
                return (
                  <TableCell key={status} className="p-1 text-right">
                    <button
                      type="button"
                      onClick={() => setFilter({ status, type: row.type })}
                      aria-pressed={active}
                      className={`w-full rounded px-2 py-1 text-right tabular-nums hover:bg-accent ${
                        active ? 'bg-accent ring-1 ring-primary' : ''
                      } ${cellTone(status, value)}`}
                    >
                      {counts ? value : '–'}
                    </button>
                  </TableCell>
                )
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {actionFailed && (
        <p role="alert" className="text-sm text-destructive">
          {t('actionFailed')}
        </p>
      )}

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
                <TableHead className="w-[210px]">{t('colType')}</TableHead>
                <TableHead className="w-[20%]">{t('colTarget')}</TableHead>
                <TableHead className="w-[60px]">{t('colAttempts')}</TableHead>
                <TableHead className="w-[120px]">{t('colUpdated')}</TableHead>
                <TableHead>{t('colError')}</TableHead>
                <TableHead className="w-[80px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>
                    <Badge variant={statusBadgeVariant(job.status)}>{t(job.status)}</Badge>
                  </TableCell>
                  <TableCell className="truncate">
                    <div className="truncate text-sm">{typeLabel(job.type)}</div>
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {job.type}
                    </div>
                  </TableCell>
                  <TableCell
                    className="truncate font-mono text-xs text-muted-foreground"
                    title={describeTarget(job.payload)}
                  >
                    {describeTarget(job.payload)}
                  </TableCell>
                  <TableCell className="text-sm">{job.attempts}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {formatDateTimeCompact(job.updated, locale)}
                  </TableCell>
                  {/* Wrapped, not cut: the end of an error is often the part that
                      says what to do. Very long ones stop at three lines, with
                      the whole of it on hover. */}
                  <TableCell title={job.lastError ?? undefined}>
                    {job.lastError && (
                      <span className="line-clamp-3 whitespace-normal break-words text-sm text-destructive">
                        {job.lastError}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {job.status === 'dead' && (
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          disabled={acting === job.id}
                          onClick={() => retry(job.id)}
                          title={t('retry')}
                          aria-label={t('retry')}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          disabled={acting === job.id}
                          onClick={() => setDeleteTarget(job.id)}
                          title={t('delete')}
                          aria-label={t('delete')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
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

      <DeleteConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('delete')}
        description={t('deleteConfirm')}
        onConfirm={confirmDelete}
        isDeleting={deleteTarget !== null && acting === deleteTarget}
      />
    </div>
  )
}
