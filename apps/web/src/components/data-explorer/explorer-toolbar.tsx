'use client'

import { Search, X } from 'lucide-react'
import { Input, Badge, Button } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import type { ColumnFilter } from '@/hooks/use-duckdb'

interface ExplorerToolbarProps {
  searchKeyword: string
  filters: ColumnFilter[]
  onSearchChange: (keyword: string) => void
  onFilterRemove: (column: string) => void
  onClearAll: () => void
}

const OPERATOR_LABELS: Record<ColumnFilter['operator'], string> = {
  eq: '=',
  neq: '\u2260',
  contains: '\u2283',
  starts_with: '^',
  ends_with: '$',
}

export function ExplorerToolbar({
  searchKeyword,
  filters,
  onSearchChange,
  onFilterRemove,
  onClearAll,
}: ExplorerToolbarProps) {
  const t = useTranslations('resource')

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-8 text-sm"
            placeholder={t('explorerSearch')}
            value={searchKeyword}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        {filters.length > 0 && (
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={onClearAll}>
            {t('explorerClearFilters')}
          </Button>
        )}
      </div>
      {filters.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {filters.map((f) => (
            <Badge key={f.column} variant="secondary" wrap className="gap-1 text-xs">
              <span>
                {f.column} {OPERATOR_LABELS[f.operator]} &quot;{f.value}&quot;
              </span>
              <button
                className="rounded-full p-0.5 hover:bg-muted"
                onClick={() => onFilterRemove(f.column)}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}
