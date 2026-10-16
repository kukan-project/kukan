/** UI locales. The edge (CloudFront viewer-request) and the web app share this list. */
export const SUPPORTED_LOCALES = ['ja', 'en'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]
export const DEFAULT_LOCALE: SupportedLocale = 'en'

/**
 * Request header carrying the locale the edge resolved. The HTML cache key
 * varies on it, so the origin must render the locale it names rather than
 * resolve its own — a page rendered for any other locale would be stored
 * under this one and served to everyone who resolves to it.
 */
export const LOCALE_HEADER = 'x-kukan-locale'
