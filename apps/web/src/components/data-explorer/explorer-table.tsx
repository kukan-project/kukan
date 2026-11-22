'use client'

import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { TableHeader, TableBody, TableHead, TableRow, TableCell, cn } from '@kukan/ui'
import type { ResourceColumn } from '@kukan/shared'
import { KEY_HEADER_CLASS, numericLayout, dataCellClass, decimalAligned } from '@/lib/table-cells'
import { columnTypeKey } from '@/lib/format-utils'
import { ColumnFilter } from './column-filter'
import { cellKey } from './cell-marks'
import type { ColumnFilter as ColumnFilterType, SortState } from '@/hooks/use-duckdb'

interface ExplorerTableProps {
  columns: string[]
  rows: Record<string, string>[]
  sort: SortState | null
  filters: ColumnFilterType[]
  primaryKey?: string[] | null
  /** The version's column schema; numeric columns are right-aligned by it. */
  schemaColumns?: ResourceColumn[] | null
  /** Cells to mark, as `cellKey`s, and what a marked one says on hover */
  marked?: Set<string>
  markTitle?: string
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
  marked,
  markTitle,
  onSortChange,
  onFilterApply,
  onFilterClear,
}: ExplorerTableProps) {
  const t = useTranslations('resource')
  /** Each column's type by name, under its heading: what a value reads as */
  const types = new Map((schemaColumns ?? []).map((c) => [c.name, c.type]))
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
    // Named, as the text views are, so a page can give the box another height
    // (the dashboard halves it)
    <div data-slot="preview-scroll" className="max-h-[600px] overflow-auto">
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
                    <span
                      className={`flex flex-col leading-tight ${isNumeric(col) ? 'items-end' : 'items-start'}`}
                    >
                      <span className="font-medium">{col}</span>
                      {types.get(col) && (
                        <span className="text-muted-foreground text-xs font-normal">
                          {t(columnTypeKey(types.get(col)!))}
                        </span>
                      )}
                    </span>
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
              {columns.map((col) => {
                // Outlined, not tinted (a tint marks a changed row in the settings), and the
                // whole cell, which a short value like `-` would not show underlined
                const mark = marked?.has(cellKey(ri, col))
                return (
                  <TableCell
                    key={col}
                    className={cn(
                      dataCellClass(isNumeric(col), primaryKey?.includes(col) ?? false),
                      mark &&
                        'text-destructive outline-1 outline-dashed outline-destructive -outline-offset-4'
                    )}
                    title={mark ? markTitle : undefined}
                    data-marked={mark || undefined}
                  >
                    {decimalAligned(row[col], maxFractions.get(col) ?? 0)}
                  </TableCell>
                )
              })}
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
