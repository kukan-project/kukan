import { FormatBadge } from './format-badge'

export function FormatBadges({ formats }: { formats: string | undefined }) {
  if (!formats) return null
  const list = formats.split(',').filter(Boolean)
  if (list.length === 0) return null

  return (
    <div className="flex shrink-0 gap-1">
      {list.map((f) => (
        <FormatBadge key={f} format={f} />
      ))}
    </div>
  )
}
