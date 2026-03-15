'use client'

import { useLocale } from 'next-intl'

export function DateTime({ value }: { value: string }) {
  const locale = useLocale()
  const date = new Date(value)
  if (isNaN(date.getTime())) return null

  const dateStr = date.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  const h = date.getHours().toString().padStart(2, '0')
  const m = date.getMinutes().toString().padStart(2, '0')
  const timeStr =
    locale === 'ja'
      ? `${h}時${m}分`
      : date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })

  const tz = new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZoneName: 'long' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value

  return (
    <time dateTime={date.toISOString()}>
      {dateStr} {timeStr}
      {tz && ` (${tz})`}
    </time>
  )
}
