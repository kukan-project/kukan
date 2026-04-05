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
