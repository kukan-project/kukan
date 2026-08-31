'use client'

import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react'
import { TableHeader, TableBody, TableHead, TableRow, TableCell } from '@kukan/ui'
import type { ResourceColumn } from '@kukan/shared'
import { KEY_HEADER_CLASS, numericLayout, dataCellClass, decimalAligned } from '@/lib/table-cells'
import { ColumnFilter } from './column-filter'
import type { ColumnFilter as ColumnFilterType, SortState } from '@/hooks/use-duckdb'

interface ExplorerTableProps {
  columns: string[]
  rows: Record<string, string>[]
  sort: SortState | null
  filters: ColumnFilterType[]
  primaryKey?: string[] | null
  /** The version's column schema; numeric columns are right-aligned by it. */
  schemaColumns?: ResourceColumn[] | null
  onSortChange: (sort: SortState | null) => void
  onFilterApply: (filter: ColumnFilterType) => void
  onFilterClear: (column: string) => void
}

export function ExplorerTable({
  columns,
  rows,
  sort,
  filters,
  primaryKey,
  schemaColumns,
  onSortChange,
  onFilterApply,
  onFilterClear,
}: ExplorerTableProps) {
  const { isNumeric, maxFractions } = numericLayout(
    columns,
    schemaColumns,
    rows,
    (row, col) => row[col]
  )

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
          div) so a single container scrolls both axes. */}
      <table className="w-max text-sm">
        <TableHeader className="sticky top-0 z-10 bg-muted">
          <TableRow>
            {columns.map((col) => (
              <TableHead
                key={col}
                className={`whitespace-nowrap px-4 py-2${
                  primaryKey?.includes(col) ? ` ${KEY_HEADER_CLASS}` : ''
                }`}
              >
                <div className={`flex items-center gap-1${isNumeric(col) ? ' justify-end' : ''}`}>
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
                <TableCell
                  key={col}
                  className={dataCellClass(isNumeric(col), primaryKey?.includes(col) ?? false)}
                >
                  {decimalAligned(row[col], maxFractions.get(col) ?? 0)}
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
