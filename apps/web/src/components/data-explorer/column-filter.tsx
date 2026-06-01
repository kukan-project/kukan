'use client'

import { useState } from 'react'
import { Filter } from 'lucide-react'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kukan/ui'
import { useTranslations } from 'next-intl'
import type { ColumnFilter as ColumnFilterType } from '@/hooks/use-duckdb'

interface ColumnFilterProps {
  column: string
  activeFilter?: ColumnFilterType
  onApply: (filter: ColumnFilterType) => void
  onClear: () => void
}

type FilterOperator = ColumnFilterType['operator']

export function ColumnFilter({ column, activeFilter, onApply, onClear }: ColumnFilterProps) {
  const t = useTranslations('resource')
  const [open, setOpen] = useState(false)
  const [operator, setOperator] = useState<FilterOperator>(activeFilter?.operator ?? 'contains')
  const [value, setValue] = useState(activeFilter?.value ?? '')

  // Sync local state when popover opens or activeFilter changes externally
  const handleOpenChange = (isOpen: boolean) => {
    if (isOpen) {
      setOperator(activeFilter?.operator ?? 'contains')
      setValue(activeFilter?.value ?? '')
    }
    setOpen(isOpen)
  }

  const handleApply = () => {
    if (!value.trim()) return
    onApply({ column, operator, value: value.trim() })
    setOpen(false)
  }

  const handleClear = () => {
    setValue('')
    setOperator('contains')
    onClear()
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          className={`inline-flex items-center rounded p-0.5 hover:bg-accent ${activeFilter ? 'text-primary' : 'text-muted-foreground/50'}`}
          aria-label={t('explorerFilterColumn', { column })}
        >
          <Filter className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64" align="start">
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium">{column}</p>
          <Select value={operator} onValueChange={(v) => setOperator(v as FilterOperator)}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="eq">{t('explorerFilterEqual')}</SelectItem>
              <SelectItem value="neq">{t('explorerFilterNotEqual')}</SelectItem>
              <SelectItem value="contains">{t('explorerFilterContains')}</SelectItem>
              <SelectItem value="starts_with">{t('explorerFilterStartsWith')}</SelectItem>
              <SelectItem value="ends_with">{t('explorerFilterEndsWith')}</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="h-8 text-xs"
            placeholder={t('explorerFilterValue')}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleApply()
            }}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleClear}>
              {t('explorerFilterClear')}
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={handleApply}
              disabled={!value.trim()}
            >
              {t('explorerFilterApply')}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
