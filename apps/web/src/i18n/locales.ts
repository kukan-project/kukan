export const SUPPORTED_LOCALES = ['ja', 'en'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]
export const DEFAULT_LOCALE: SupportedLocale = 'en'

export function isSupportedLocale(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

/**
 * Brand-facing text: a plain string applies to all locales, a map selects
 * per locale. Missing entries fall back to the default locale, then to any
 * defined entry.
 */
export type LocalizedText = string | Partial<Record<SupportedLocale, string>>

export function resolveLocalizedText(text: LocalizedText, locale: string): string {
  if (typeof text === 'string') return text
  return (
    text[locale as SupportedLocale] ??
    text[DEFAULT_LOCALE] ??
    SUPPORTED_LOCALES.map((l) => text[l]).find((value) => value !== undefined) ??
    ''
  )
}
