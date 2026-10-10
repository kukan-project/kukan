import { getLocale } from 'next-intl/server'
import { getSiteMetadata } from '@/lib/server-api'
import {
  formatSiteDate,
  formatSiteNumber,
  type SiteCalendar,
  type SiteNumberOptions,
} from '@/lib/site-metadata'

// Server components: they read the site metadata themselves. `name` is the
// metadata key (React keeps `key` for itself). Nothing renders when the key is
// missing or holds another type.

/** A number from the site metadata, in the page's locale (ADR-064 §4) */
export async function SiteNumber({ name, ...options }: { name: string } & SiteNumberOptions) {
  const [metadata, locale] = await Promise.all([getSiteMetadata(), getLocale()])
  const value = metadata.number(name)
  return value === undefined ? null : formatSiteNumber(value, locale, options)
}

/** A date from the site metadata; Japanese era on a Japanese page unless `calendar` says */
export async function SiteDate({ name, calendar }: { name: string; calendar?: SiteCalendar }) {
  const [metadata, locale] = await Promise.all([getSiteMetadata(), getLocale()])
  const value = metadata.date(name)
  return value === undefined ? null : (
    <time dateTime={value}>{formatSiteDate(value, locale, calendar)}</time>
  )
}

/** A text from the site metadata, resolved for the page's locale */
export async function SiteText({ name }: { name: string }) {
  const [metadata, locale] = await Promise.all([getSiteMetadata(), getLocale()])
  return metadata.text(name, locale) ?? null
}
