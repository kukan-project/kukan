'use client'

import { useLocale } from 'next-intl'

export function formatDateTime(isoString: string, locale: string): string {
  const d = new Date(isoString)
  if (isNaN(d.getTime())) return ''

  const dateStr = d.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' })
  const h = d.getHours().toString().padStart(2, '0')
  const m = d.getMinutes().toString().padStart(2, '0')
  const timeStr =
    locale === 'ja'
      ? `${h}時${m}分`
      : d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })

  const tz = new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZoneName: 'long' })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')?.value

  return `${dateStr} ${timeStr}${tz ? ` (${tz})` : ''}`
}

export function formatDateTimeCompact(isoString: string, locale: string): string {
  const d = new Date(isoString)
  if (isNaN(d.getTime())) return ''

  return d.toLocaleString(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function DateTime({ value }: { value: string }) {
  const locale = useLocale()
  const formatted = formatDateTime(value, locale)
  if (!formatted) return null

  return <time dateTime={value}>{formatted}</time>
}

export function CompactDate({ value }: { value: string }) {
  const locale = useLocale()
  const d = new Date(value)
  if (isNaN(d.getTime())) return null

  const formatted = d.toLocaleDateString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })

  return <time dateTime={value}>{formatted}</time>
}
