import { getFormatColorClass } from '@/lib/format-colors'

export function FormatBadges({ formats }: { formats: string | undefined }) {
  if (!formats) return null
  const list = formats.split(',').filter(Boolean)
  if (list.length === 0) return null

  return (
    <div className="flex shrink-0 gap-1">
      {list.map((f) => (
        <span
          key={f}
          className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase leading-tight ${getFormatColorClass(f)}`}
        >
          {f}
        </span>
      ))}
    </div>
  )
}
