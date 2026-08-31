'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { Card, CardContent, Skeleton } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import type { ResourceColumn } from '@kukan/shared'
import { useDuckDB, type ColumnFilter, type SortState } from '@/hooks/use-duckdb'
import { useParquetPreview } from '@/hooks/use-parquet-preview'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { formatCell } from '@/lib/format-utils'
import { ExplorerToolbar } from './explorer-toolbar'
import { ExplorerTable } from './explorer-table'
import { PreviewFooter } from '../preview-footer'

const PAGE_SIZE = 100

interface DataExplorerProps {
  resourceId: string
  primaryKey?: string[] | null
  /** The version's column schema, for key marking and numeric alignment. */
  schemaColumns?: ResourceColumn[] | null
}

/**
 * The one table preview (ADR-048). It opens as a plain hyparquet reader —
 * range reads, no engine, free for the server and the client alike — and the
 * first sort/filter/search boots DuckDB-WASM in the background. Interactions
 * made while the engine loads are ordinary React state, so they apply on the
 * query the engine runs once ready: the intent queue costs nothing.
 */
export function DataExplorer({ resourceId, primaryKey, schemaColumns }: DataExplorerProps) {
  const t = useTranslations('resource')
  const [sort, setSort] = useState<SortState | null>(null)
  const [filters, setFilters] = useState<ColumnFilter[]>([])
  const [searchKeyword, setSearchKeyword] = useState('')
  const [page, setPage] = useState(0)
  const [engineWanted, setEngineWanted] = useState(false)
  const [engineFailed, setEngineFailed] = useState(false)

  const debouncedSearch = useDebouncedValue(searchKeyword)

  const staticSource = useParquetPreview({ resourceId, pageSize: PAGE_SIZE })
  const duck = useDuckDB({ resourceId, enabled: engineWanted })

  // An engine failure demotes the table to plain reading. The criteria the
  // engine never applied are dropped with it — sort arrows and filter badges
  // must not claim a state the visible rows are not in — and releasing
  // engineWanted lets the next interaction boot the engine again.
  useEffect(() => {
    if (!duck.error || !engineWanted) return
    setEngineFailed(true)
    setEngineWanted(false)
    setSort(null)
    setFilters([])
    setSearchKeyword('')
    setPage(0)
  }, [duck.error, engineWanted])

  useEffect(() => {
    // Only a healthy engine clears the note: after a query failure `ready`
    // stays true while `error` is set, and clearing on `ready` alone would
    // race the demotion above and hide it.
    if (duck.ready && !duck.error) setEngineFailed(false)
  }, [duck.ready, duck.error])

  // The engine takes over as soon as it is ready; until then the static
  // reader keeps serving pages, even while the engine boots.
  const engineActive = duck.ready
  const { query: duckQuery } = duck

  const prevCriteriaRef = useRef({ sort, filters, debouncedSearch })
  useEffect(() => {
    if (!engineActive) return

    // Reset to the first page when the criteria change (not on page turns).
    // The ref starts at the initial state, so the first run after boot sees
    // the interaction that requested the engine as a criteria change.
    const prev = prevCriteriaRef.current
    const criteriaChanged =
      prev.sort !== sort || prev.filters !== filters || prev.debouncedSearch !== debouncedSearch
    prevCriteriaRef.current = { sort, filters, debouncedSearch }

    const effectivePage = criteriaChanged ? 0 : page
    if (criteriaChanged && page !== 0) {
      setPage(0)
    }
    duckQuery({
      sort: sort ?? undefined,
      filters: filters.length > 0 ? filters : undefined,
      searchKeyword: debouncedSearch || undefined,
      page: effectivePage,
      pageSize: PAGE_SIZE,
    })
  }, [engineActive, duckQuery, sort, filters, debouncedSearch, page])

  const handleSortChange = (next: SortState | null) => {
    setEngineWanted(true)
    setSort(next)
  }

  const handleSearchChange = (keyword: string) => {
    if (keyword) setEngineWanted(true)
    setSearchKeyword(keyword)
  }

  const handleFilterApply = (filter: ColumnFilter) => {
    setEngineWanted(true)
    setFilters((prev) => {
      const without = prev.filter((f) => f.column !== filter.column)
      return [...without, filter]
    })
  }

  const handleFilterRemove = (column: string) => {
    setFilters((prev) => prev.filter((f) => f.column !== column))
  }

  const handleClearAll = () => {
    setSort(null)
    setFilters([])
    setSearchKeyword('')
    setPage(0)
  }

  // Static rows arrive as raw Parquet values; the engine's rows are already
  // display strings. Formatted here so ExplorerTable reads them the one way.
  const staticRows = useMemo(() => {
    const cols = staticSource.metadata?.columns ?? []
    return staticSource.rows.map((row) => {
      const obj: Record<string, string> = {}
      for (const col of cols) obj[col] = formatCell(row[col])
      return obj
    })
  }, [staticSource.metadata, staticSource.rows])

  if (staticSource.loading) {
    return (
      <Card>
        <CardContent className="space-y-3 p-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (staticSource.error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('previewError')}
        </CardContent>
      </Card>
    )
  }

  if (!staticSource.metadata) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('previewNoData')}
        </CardContent>
      </Card>
    )
  }

  if (staticSource.metadata.numRows === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('previewEmpty')}
        </CardContent>
      </Card>
    )
  }

  const columns = engineActive ? duck.columns : staticSource.metadata.columns
  const rows = engineActive ? duck.rows : staticRows
  const totalRows = engineActive ? duck.totalRows : staticSource.metadata.numRows
  const filteredRows = engineActive ? duck.filteredRows : totalRows
  const totalPages = engineActive
    ? Math.max(1, Math.ceil(filteredRows / PAGE_SIZE))
    : staticSource.totalPages
  const currentPage = engineActive ? page : staticSource.page
  const booting = engineWanted && !engineActive && duck.loading
  // The boot indicator never blocks: paging and further sorts/filters stay
  // available and simply queue for the engine.
  const fetching = duck.queryLoading || staticSource.pageLoading

  const summary =
    filteredRows === totalRows
      ? t('previewTotalRows', { count: totalRows })
      : t('explorerFilteredRows', { filtered: filteredRows, total: totalRows })

  return (
    <div className="flex flex-col gap-3">
      <ExplorerToolbar
        searchKeyword={searchKeyword}
        filters={filters}
        onSearchChange={handleSearchChange}
        onFilterRemove={handleFilterRemove}
        onClearAll={handleClearAll}
      />
      {engineFailed && <p className="text-sm text-destructive">{t('explorerError')}</p>}
      <div className="overflow-hidden rounded-lg border">
        <div className="relative">
          {(booting || fetching) && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background/50">
              <span className="text-sm text-muted-foreground">
                {booting ? t('explorerLoading') : t('previewLoadingPage')}
              </span>
            </div>
          )}
          <ExplorerTable
            columns={columns}
            rows={rows}
            sort={sort}
            filters={filters}
            primaryKey={primaryKey}
            schemaColumns={schemaColumns}
            onSortChange={handleSortChange}
            onFilterApply={handleFilterApply}
            onFilterClear={handleFilterRemove}
          />
        </div>
        <PreviewFooter
          summary={summary}
          page={currentPage}
          totalPages={totalPages}
          busy={fetching}
          onPageChange={engineActive ? setPage : staticSource.goToPage}
        />
      </div>
    </div>
  )
}
