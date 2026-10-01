'use client'

import { Fragment, useCallback, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ArrowRight, RotateCcw, Trash2 } from 'lucide-react'
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
import { RefreshButton } from '@/components/dashboard/refresh-button'
import { PaginationControls } from '@/components/dashboard/pagination-controls'
import { DeleteConfirmDialog } from '@/components/dashboard/delete-confirm-dialog'
import { clientFetch } from '@/lib/client-api'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'
import { useAutoRefresh } from '@/hooks/use-auto-refresh'
import { useLatestJson } from '@/hooks/use-latest-json'
import { formatDateTimeCompact } from '@/components/date-time'
import {
  BACKFILL_VERSIONS_JOB_TYPE,
  CONVERT_SET_ASIDE_JOB_TYPE,
  DROP_LAKE_TABLES_JOB_TYPE,
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
  SYNC_SEARCH_DOCS_JOB_TYPE,
  type JobPriority,
  type JobStatus,
} from '@kukan/shared'

interface JobCount {
  type: string
  status: JobStatus
  count: number
}

/**
 * Every job type, by what sets it off: the writes of every day, an
 * administrator's button (or the worker finding the index lost), and the
 * one-off steps an upgrade asks for. Within a section, in the order they
 * matter; a type not listed goes in a last one.
 */
const JOB_SECTIONS: { key: string; types: string[] }[] = [
  {
    // In the order the data moves after a write: each feeds the next
    key: 'routine',
    types: [PIPELINE_JOB_TYPE, LAKE_INGEST_JOB_TYPE, SYNC_SEARCH_DOCS_JOB_TYPE, EMBED_JOB_TYPE],
  },
  {
    // Rebuilding first, removing last; the bulk descriptions fan out one job per dataset
    key: 'admin',
    types: [
      REINDEX_JOB_TYPE,
      SUMMARIZE_ALL_JOB_TYPE,
      SUMMARIZE_PACKAGE_JOB_TYPE,
      PURGE_VERSION_JOB_TYPE,
      DROP_LAKE_TABLES_JOB_TYPE,
      PURGE_ORG_JOB_TYPE,
    ],
  },
  {
    // In the order an upgrade runs them; the re-analysis stands apart from the rest
    key: 'migration',
    types: [
      BACKFILL_VERSIONS_JOB_TYPE,
      CONVERT_SET_ASIDE_JOB_TYPE,
      RECORD_ROW_GROUPS_JOB_TYPE,
      REANALYSE_INDEX_JOB_TYPE,
    ],
  },
]
const KNOWN_TYPES = new Set(JOB_SECTIONS.flatMap((s) => s.types))

/** The statuses a job reaches from the one before it; dead is where it ends up, not a next step. */
const FLOW_STEPS: JobStatus[] = ['waiting', 'running']

/** Where there are jobs, in the accent; dead ones in red; empty cells recede. */
function cellTone(status: JobStatus, value: number): string {
  if (value === 0) return 'text-muted-foreground'
  return status === 'dead' ? 'font-semibold text-destructive' : 'font-semibold text-primary'
}

interface JobItem {
  id: string
  type: string
  payload: unknown
  status: JobStatus
  priority: JobPriority
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

  const { data: countsData, fetch: fetchCounts } = useLatestJson<{ items: JobCount[] }>(
    '/api/v1/admin/queue/counts'
  )
  const counts = countsData?.items ?? null

  // What is coming next, of every type; dead jobs show as red counts
  const [filter, setFilter] = useState<{ status: JobStatus; type?: string }>({
    status: 'scheduled',
  })
  const jobsUrl = useMemo(() => {
    const params = new URLSearchParams({ status: filter.status })
    if (filter.type) params.set('type', filter.type)
    return `/api/v1/admin/queue/jobs?${params}`
  }, [filter])
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

  const [acting, setActing] = useState<string | null>(null)
  const [actionFailed, setActionFailed] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const reload = useCallback(
    () => Promise.all([fetchPage(offset), fetchCounts()]),
    [fetchPage, fetchCounts, offset]
  )

  const { spinning, refreshing, refresh } = useAutoRefresh({
    poll: () => Promise.all([refreshPage(), fetchCounts()]),
    reload,
    // The table holds still behind the delete dialog
    enabled: deleteTarget === null,
  })

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
  const unknownTypes = [
    ...new Set((counts ?? []).map((c) => c.type).filter((type) => !KNOWN_TYPES.has(type))),
  ].sort()
  const sections = [
    ...JOB_SECTIONS,
    ...(unknownTypes.length > 0 ? [{ key: 'other', types: unknownTypes }] : []),
  ]
  const typeLabel = (type: string) => (t.has(`types.${type}`) ? t(`types.${type}`) : type)
  // A type's row of counts, or the total's when `type` is undefined
  const countRow = (type: string | undefined, label: string) => (
    <TableRow key={type ?? 'total'} className={type ? undefined : 'font-semibold'}>
      <TableCell>{label}</TableCell>
      {JOB_STATUSES.map((status) => {
        const value = countOf(type, status)
        const active = filter.status === status && filter.type === type
        return (
          <TableCell key={status} className="p-1 text-right">
            <button
              type="button"
              onClick={() => setFilter({ status, type })}
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
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')}>
        <RefreshButton onClick={refresh} disabled={refreshing} spinning={spinning} />
      </PageHeader>
      <p className="-mt-3 text-sm text-muted-foreground">{t('description')}</p>

      <Table>
        {/* No rule under the column names: the first section heading draws it */}
        <TableHeader className="[&_tr]:border-b-0">
          <TableRow>
            <TableHead>{t('colJobType')}</TableHead>
            {JOB_STATUSES.map((status) => (
              <TableHead key={status} className="w-[100px] text-right">
                {FLOW_STEPS.includes(status) && (
                  <ArrowRight
                    aria-hidden
                    className="mr-2 inline h-3.5 w-3.5 align-[-2px] text-muted-foreground"
                  />
                )}
                {t(status)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sections.map((section, i) => (
            <Fragment key={section.key}>
              {/* The heading belongs to the rows below it: space above it, none
                  between, so the sections read apart without a band of their own */}
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={1 + JOB_STATUSES.length}
                  className={`pb-1.5 text-xs font-semibold text-muted-foreground ${
                    i > 0 ? 'pt-7' : 'pt-3'
                  }`}
                >
                  {t(`sections.${section.key}`)}
                </TableCell>
              </TableRow>
              {section.types.map((type) => countRow(type, typeLabel(type)))}
            </Fragment>
          ))}
          {countRow(undefined, t('total'))}
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
                <TableHead className="w-[70px]">{t('colPriority')}</TableHead>
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
                  {/* Normal recedes: the other two are what moved a job in the line */}
                  <TableCell
                    className={`text-sm ${job.priority === 'normal' ? 'text-muted-foreground' : ''}`}
                  >
                    {t(`priorities.${job.priority}`)}
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
