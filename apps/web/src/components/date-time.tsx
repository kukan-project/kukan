'use client'

import { useSyncExternalStore } from 'react'
import { useLocale, useTimeZone } from 'next-intl'

/** `timeZone` undefined means the host's, as `Date` getters would. */
export function formatDateTime(isoString: string, locale: string, timeZone?: string): string {
  const d = new Date(isoString)
  if (isNaN(d.getTime())) return ''

  const dateStr = formatDate(isoString, locale, timeZone, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  const clock = { hour: '2-digit', minute: '2-digit', timeZone } as const
  // No ja pattern gives 19時30分, so read the fields and place the units —
  // reading them beats splitting on whatever separator the locale data holds.
  const timeStr =
    locale === 'ja'
      ? jaUnits(new Intl.DateTimeFormat('ja', { ...clock, hourCycle: 'h23' }).formatToParts(d))
      : d.toLocaleTimeString(locale, clock)

  const tz = new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZoneName: 'long', timeZone })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')?.value

  return `${dateStr} ${timeStr}${tz ? ` (${tz})` : ''}`
}

function jaUnits(parts: Intl.DateTimeFormatPart[]): string {
  // Padded here rather than trusted to the engine: `2-digit` is what every ICU
  // we know gives, but the two-digit clock is ours to guarantee.
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    (parts.find((p) => p.type === type)?.value ?? '').padStart(2, '0')
  return `${value('hour')}時${value('minute')}分`
}

/** The date alone. Options default to the numeric form the resource lists use. */
export function formatDate(
  isoString: string,
  locale: string,
  timeZone?: string,
  options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' }
): string {
  const d = new Date(isoString)
  if (isNaN(d.getTime())) return ''

  return d.toLocaleDateString(locale, { ...options, timeZone })
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

const subscribeToNothing = () => () => {}

/**
 * The zone to format in for this render. The viewer's is unknown until the
 * browser runs, and hydration must reproduce the server's text exactly, so the
 * server and the first client render both use the site's zone (TIME_ZONE, via
 * next-intl); undefined — the viewer's — takes over right after.
 */
function useRenderTimeZone(): string | undefined {
  const siteTimeZone = useTimeZone()
  return useSyncExternalStore(
    subscribeToNothing,
    () => undefined,
    () => siteTimeZone
  )
}

/** The instant as the viewer will see it, or '' for nothing to show. */
export function useFormattedDateTime(isoString: string | null | undefined): string {
  const locale = useLocale()
  const timeZone = useRenderTimeZone()
  return isoString ? formatDateTime(isoString, locale, timeZone) : ''
}

export function DateTime({ value }: { value: string }) {
  const formatted = useFormattedDateTime(value)
  if (!formatted) return null

  return <time dateTime={value}>{formatted}</time>
}

export function CompactDate({ value }: { value: string }) {
  const locale = useLocale()
  const timeZone = useRenderTimeZone()
  const formatted = formatDate(value, locale, timeZone)
  if (!formatted) return null

  return <time dateTime={value}>{formatted}</time>
}
