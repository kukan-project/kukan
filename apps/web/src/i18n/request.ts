import { cookies, headers } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'

// Barrel import so the @/brand alias resolves the active brand (ADR-042).
import { messages as BRAND_MESSAGES } from '@/brand/messages'

import { deepMerge, type Messages } from './deep-merge'
import { DEFAULT_LOCALE, isSupportedLocale, type SupportedLocale } from './locales'

function parseAcceptLanguage(header: string): SupportedLocale | undefined {
  const tags = header
    .split(',')
    .map((part) => {
      const [tag, q] = part.trim().split(';q=')
      return { lang: tag.trim().toLowerCase(), q: q ? parseFloat(q) : 1 }
    })
    .sort((a, b) => b.q - a.q)

  for (const { lang } of tags) {
    if (isSupportedLocale(lang)) return lang
    const prefix = lang.split('-')[0]
    if (isSupportedLocale(prefix)) return prefix
  }
  return undefined
}

export default getRequestConfig(async () => {
  const cookieStore = await cookies()
  const cookieLocale = cookieStore.get('NEXT_LOCALE')?.value

  let locale: SupportedLocale = DEFAULT_LOCALE
  if (cookieLocale && isSupportedLocale(cookieLocale)) {
    locale = cookieLocale
  } else {
    const acceptLang = (await headers()).get('accept-language')
    if (acceptLang) {
      locale = parseAcceptLanguage(acceptLang) ?? DEFAULT_LOCALE
    }
  }

  const defaultMessages: Messages = (await import(`../../messages/${locale}.json`)).default
  const brandMessages = BRAND_MESSAGES[locale]
  const messages =
    Object.keys(brandMessages).length > 0
      ? deepMerge(defaultMessages, brandMessages)
      : defaultMessages

  return {
    locale,
    messages,
  }
})
