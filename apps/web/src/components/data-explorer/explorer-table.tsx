'use client'

import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react'
import { TableHeader, TableBody, TableHead, TableRow, TableCell } from '@kukan/ui'
import { ColumnFilter } from './column-filter'
import type { ColumnFilter as ColumnFilterType, SortState } from '@/hooks/use-duckdb'

interface ExplorerTableProps {
  columns: string[]
  rows: Record<string, string>[]
  sort: SortState | null
  filters: ColumnFilterType[]
  onSortChange: (sort: SortState | null) => void
  onFilterApply: (filter: ColumnFilterType) => void
  onFilterClear: (column: string) => void
}

export function ExplorerTable({
  columns,
  rows,
  sort,
  filters,
  onSortChange,
  onFilterApply,
  onFilterClear,
}: ExplorerTableProps) {
  const handleSort = (column: string) => {
    if (!sort || sort.column !== column) {
      onSortChange({ column, direction: 'ASC' })
    } else if (sort.direction === 'ASC') {
      onSortChange({ column, direction: 'DESC' })
    } else {
      onSortChange(null)
    }
  }

  const getSortIcon = (column: string) => {
    if (!sort || sort.column !== column) {
      return <ArrowUpDown className="size-3 text-muted-foreground/30" />
    }
    return sort.direction === 'ASC' ? (
      <ArrowUp className="size-3 text-primary" />
    ) : (
      <ArrowDown className="size-3 text-primary" />
    )
  }

  return (
    <div className="max-h-[600px] overflow-auto">
      {/* Raw <table> (not the @kukan/ui Table, which wraps in its own overflow-x-auto
          div) so a single container scrolls both axes — matching ParquetPreview. */}
      <table className="w-max text-sm">
        <TableHeader className="sticky top-0 z-10 bg-muted">
          <TableRow>
            {columns.map((col) => (
              <TableHead key={col} className="whitespace-nowrap px-4 py-2">
                <div className="flex items-center gap-1">
                  <button
                    className="flex items-center gap-1 hover:text-foreground"
                    onClick={() => handleSort(col)}
                  >
                    <span className="font-medium">{col}</span>
                    {getSortIcon(col)}
                  </button>
                  <ColumnFilter
                    column={col}
                    activeFilter={filters.find((f) => f.column === col)}
                    onApply={onFilterApply}
                    onClear={() => onFilterClear(col)}
                  />
                </div>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, ri) => (
            <TableRow key={ri}>
              {columns.map((col) => (
                <TableCell key={col} className="whitespace-nowrap px-4 py-2">
                  {row[col]}
                </TableCell>
              ))}
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="py-8 text-center text-muted-foreground"
              >
                -
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </table>
    </div>
  )
}
