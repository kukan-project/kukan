import type { ReactNode } from 'react'

export interface KeyValueRow {
  label: string
  value: ReactNode
}

export function extrasToRows(extras: Record<string, unknown> | null | undefined): KeyValueRow[] {
  if (!extras) return []
  return Object.entries(extras)
    .filter(([, v]) => v != null && v !== '')
    .map(([key, value]) => ({ label: key, value: String(value) }))
}

export function KeyValueTable({ rows }: { rows: KeyValueRow[] }) {
  const filtered = rows.filter((row) => row.value)

  if (filtered.length === 0) return null

  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full">
        <tbody>
          {filtered.map((row, i) => (
            <tr key={row.label} className={i % 2 === 0 ? 'bg-muted/50' : ''}>
              <th className="w-1/3 px-4 py-3 text-left text-sm font-medium">{row.label}</th>
              <td className="px-4 py-3 text-sm">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
