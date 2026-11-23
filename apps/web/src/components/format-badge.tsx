import { Table2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { getFormatColorClass } from '@/lib/format-colors'
import { cn } from '@kukan/ui'

export function FormatBadge({ format, className }: { format: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase leading-tight',
        getFormatColorClass(format),
        className
      )}
    >
      {format}
    </span>
  )
}

/**
 * That a resource was read as a table — whatever its format says (a workbook,
 * a JSON) — as an icon beside its format badge in a list, named on hover and
 * to a screen reader (ADR-057 decision 9).
 */
export function TableBadge({ className }: { className?: string }) {
  const t = useTranslations('resource')
  const label = t('hasTableBadge')
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn('inline-flex items-center text-muted-foreground', className)}
    >
      <Table2 className="size-3.5" aria-hidden />
    </span>
  )
}
