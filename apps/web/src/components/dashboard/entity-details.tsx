'use client'

import { useTranslations } from 'next-intl'

interface EntityDetailsProps {
  name: string
  title?: string | null
  description?: string | null
  imageUrl?: string | null
}

/**
 * Read-only counterpart of OrganizationForm / GroupForm — the same fields with
 * no controls, shown to viewers who lack admin in the entity.
 */
export function EntityDetails({ name, title, description, imageUrl }: EntityDetailsProps) {
  const tc = useTranslations('common')
  const rows: [string, string | null | undefined][] = [
    [tc('urlIdentifier'), name],
    [tc('title'), title],
    [tc('description'), description],
    [tc('imageUrl'), imageUrl],
  ]

  return (
    <dl className="flex flex-col gap-4">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-1">
          <dt className="text-sm font-medium">{label}</dt>
          <dd className="whitespace-pre-wrap text-sm text-muted-foreground">{value || '-'}</dd>
        </div>
      ))}
    </dl>
  )
}
