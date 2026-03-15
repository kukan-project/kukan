import { cookies, headers } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'

const SUPPORTED_LOCALES = ['ja', 'en'] as const
type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]
const DEFAULT_LOCALE: SupportedLocale = 'en'

function isSupported(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

function parseAcceptLanguage(header: string): SupportedLocale | undefined {
  const tags = header
    .split(',')
    .map((part) => {
      const [tag, q] = part.trim().split(';q=')
      return { lang: tag.trim().toLowerCase(), q: q ? parseFloat(q) : 1 }
    })
    .sort((a, b) => b.q - a.q)

  for (const { lang } of tags) {
    if (isSupported(lang)) return lang
    const prefix = lang.split('-')[0]
    if (isSupported(prefix)) return prefix
  }
  return undefined
}

export default getRequestConfig(async () => {
  const cookieStore = await cookies()
  const cookieLocale = cookieStore.get('NEXT_LOCALE')?.value

  let locale: SupportedLocale = DEFAULT_LOCALE
  if (cookieLocale && isSupported(cookieLocale)) {
    locale = cookieLocale
  } else {
    const acceptLang = (await headers()).get('accept-language')
    if (acceptLang) {
      locale = parseAcceptLanguage(acceptLang) ?? DEFAULT_LOCALE
    }
  }

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  }
})
