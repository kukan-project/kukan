'use client'

import { useState, useEffect, useRef } from 'react'
import { Card, CardContent, Skeleton } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { useDuckDB, type ColumnFilter, type SortState } from '@/hooks/use-duckdb'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { ExplorerToolbar } from './explorer-toolbar'
import { ExplorerTable } from './explorer-table'
import { PreviewFooter } from '../preview-footer'

const PAGE_SIZE = 100

interface DataExplorerProps {
  resourceId: string
}

export function DataExplorer({ resourceId }: DataExplorerProps) {
  const t = useTranslations('resource')
  const [sort, setSort] = useState<SortState | null>(null)
  const [filters, setFilters] = useState<ColumnFilter[]>([])
  const [searchKeyword, setSearchKeyword] = useState('')
  const [page, setPage] = useState(0)

  const debouncedSearch = useDebouncedValue(searchKeyword)

  const { ready, loading, queryLoading, error, columns, totalRows, filteredRows, rows, query } =
    useDuckDB({ resourceId, enabled: true })

  const totalPages = Math.max(1, Math.ceil(filteredRows / PAGE_SIZE))

  const prevSortRef = useRef(sort)
  const prevFiltersRef = useRef(filters)
  const prevSearchRef = useRef(debouncedSearch)
  const initialLoadRef = useRef(true)

  useEffect(() => {
    if (!ready) return

    // Skip the first effect run — useDuckDB init already loaded page 0
    if (initialLoadRef.current) {
      initialLoadRef.current = false
      return
    }

    // Reset page to 0 when sort/filter/search changes (not on page-only changes)
    const criteriaChanged =
      prevSortRef.current !== sort ||
      prevFiltersRef.current !== filters ||
      prevSearchRef.current !== debouncedSearch
    prevSortRef.current = sort
    prevFiltersRef.current = filters
    prevSearchRef.current = debouncedSearch

    const effectivePage = criteriaChanged ? 0 : page
    if (criteriaChanged && page !== 0) {
      setPage(0)
    }

    query({
      sort: sort ?? undefined,
      filters: filters.length > 0 ? filters : undefined,
      searchKeyword: debouncedSearch || undefined,
      page: effectivePage,
      pageSize: PAGE_SIZE,
    })
  }, [ready, query, sort, filters, debouncedSearch, page])

  const handleFilterApply = (filter: ColumnFilter) => {
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

  if (loading) {
    return (
      <Card>
        <CardContent className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">{t('explorerLoading')}</p>
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('explorerError')}
        </CardContent>
      </Card>
    )
  }

  if (!ready) return null

  // Named, because the branch is the one thing the explorer's footer has that
  // the Parquet preview's does not: a filter, and rows it left behind.
  const summary =
    filteredRows === totalRows
      ? t('previewTotalRows', { count: totalRows })
      : t('explorerFilteredRows', { filtered: filteredRows, total: totalRows })

  return (
    <div className="flex flex-col gap-3">
      <ExplorerToolbar
        searchKeyword={searchKeyword}
        filters={filters}
        onSearchChange={setSearchKeyword}
        onFilterRemove={handleFilterRemove}
        onClearAll={handleClearAll}
      />
      {/* One box around the table and its footer, as the Parquet preview has. */}
      <div className="overflow-hidden rounded-lg border">
        <ExplorerTable
          columns={columns}
          rows={rows}
          sort={sort}
          filters={filters}
          onSortChange={setSort}
          onFilterApply={handleFilterApply}
          onFilterClear={handleFilterRemove}
        />
        <PreviewFooter
          summary={summary}
          page={page}
          totalPages={totalPages}
          busy={queryLoading}
          onPageChange={setPage}
        />
      </div>
    </div>
  )
}
