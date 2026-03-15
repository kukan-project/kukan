import { cookies } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'

const SUPPORTED_LOCALES = ['ja', 'en'] as const
const DEFAULT_LOCALE = 'ja'

export default getRequestConfig(async () => {
  const cookieStore = await cookies()
  const cookieLocale = cookieStore.get('NEXT_LOCALE')?.value
  const locale =
    cookieLocale && (SUPPORTED_LOCALES as readonly string[]).includes(cookieLocale)
      ? cookieLocale
      : DEFAULT_LOCALE

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  }
})
