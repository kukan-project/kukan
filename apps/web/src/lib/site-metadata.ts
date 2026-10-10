import { siteMetadataDateSchema, type SiteMetadataValues } from '@kukan/shared'
import { resolveLocalizedText, SUPPORTED_LOCALES, type LocalizedText } from '@/i18n/locales'

export type SiteCalendar = 'japanese' | 'gregory'

/**
 * Typed reads of the site metadata (ADR-064 §4). A key that is missing, or
 * whose value is not of the asked type, reads as undefined — renaming a key in
 * the admin screen empties whatever read it rather than breaking the page.
 */
export interface SiteMetadata {
  number(key: string): number | undefined
  /** A per-locale value resolved for `locale` */
  text(key: string, locale: string): string | undefined
  /** The ISO date (YYYY-MM-DD), when the value is one */
  date(key: string): string | undefined
}

export function createSiteMetadata(values: SiteMetadataValues = {}): SiteMetadata {
  const get = (key: string): unknown => (Object.hasOwn(values, key) ? values[key] : undefined)
  return {
    number(key) {
      const value = get(key)
      return typeof value === 'number' ? value : undefined
    },
    text(key, locale) {
      const value = get(key)
      return isLocalizedText(value) ? resolveLocalizedText(value, locale) : undefined
    },
    date(key) {
      const value = get(key)
      // The save-time check, not Date.parse: that rolls 2026-02-30 over to March 2.
      // A text entry can hold any string, so its shape is not enough either
      return siteMetadataDateSchema.safeParse(value).success ? (value as string) : undefined
    },
  }
}

function isLocalizedText(value: unknown): value is LocalizedText {
  if (typeof value === 'string') return true
  if (typeof value !== 'object' || value === null) return false
  const entries = Object.entries(value)
  return (
    entries.length > 0 &&
    entries.every(
      ([locale, text]) =>
        (SUPPORTED_LOCALES as readonly string[]).includes(locale) && typeof text === 'string'
    )
  )
}

export interface SiteNumberOptions {
  /** Show a plus sign on positive values (a change from last month) */
  signed?: boolean
  /** Fixed number of decimals; the value's own when omitted */
  fractionDigits?: number
}

export function formatSiteNumber(
  value: number,
  locale: string,
  { signed = false, fractionDigits }: SiteNumberOptions = {}
): string {
  return new Intl.NumberFormat(locale, {
    signDisplay: signed ? 'exceptZero' : 'auto',
    minimumFractionDigits: fractionDigits,
    // Intl stops at 3 decimals by default, which would show 0.0001 as 0
    maximumFractionDigits: fractionDigits ?? 20,
  }).format(value)
}

/** Japanese era dates for a Japanese page, Gregorian ones otherwise */
export function defaultSiteCalendar(locale: string): SiteCalendar {
  return locale === 'ja' ? 'japanese' : 'gregory'
}

/** `isoDate` is a calendar date, so it is formatted in UTC to keep its day */
export function formatSiteDate(
  isoDate: string,
  locale: string,
  calendar: SiteCalendar = defaultSiteCalendar(locale)
): string {
  return new Intl.DateTimeFormat(locale, { calendar, dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(isoDate)
  )
}
