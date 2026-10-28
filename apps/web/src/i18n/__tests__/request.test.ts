import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { LOCALE_HEADER } from '@kukan/shared'
import en from '../../../messages/en.json'
import ja from '../../../messages/ja.json'

let headerValues: Record<string, string> = {}
let cookieLocale: string | undefined

vi.mock('next/headers', () => ({
  headers: async () => new Headers(headerValues),
  cookies: async () => ({
    get: (name: string) =>
      name === 'NEXT_LOCALE' && cookieLocale !== undefined ? { value: cookieLocale } : undefined,
  }),
}))

// Hand back the callback itself, so a test can call it as next-intl would
vi.mock('next-intl/server', () => ({
  getRequestConfig: (fn: unknown) => fn,
}))

vi.mock('@/brand/messages', () => ({
  messages: { en: {}, ja: { brandOnly: { greeting: 'ようこそ' } } },
}))

type Config = { locale: string; messages: Record<string, unknown>; timeZone: string }
let requestConfig: () => Promise<Config>

beforeAll(async () => {
  vi.stubEnv('TIME_ZONE', 'Europe/London')
  requestConfig = (await import('../request')).default as unknown as () => Promise<Config>
  vi.unstubAllEnvs()
})

beforeEach(() => {
  headerValues = {}
  cookieLocale = undefined
})

describe('i18n request config', () => {
  it('takes the locale the edge chose over the cookie and the browser', async () => {
    headerValues = { [LOCALE_HEADER]: 'ja', 'accept-language': 'en' }
    cookieLocale = 'en'
    expect((await requestConfig()).locale).toBe('ja')
  })

  it('falls to the cookie when the edge’s choice is not a supported locale', async () => {
    headerValues = { [LOCALE_HEADER]: 'fr', 'accept-language': 'en' }
    cookieLocale = 'ja'
    expect((await requestConfig()).locale).toBe('ja')
  })

  it('reads Accept-Language by weight, matching a regional tag by its language', async () => {
    cookieLocale = 'fr'
    headerValues = { 'accept-language': 'fr;q=0.9, en-GB;q=0.5, ja-JP;q=0.8' }
    expect((await requestConfig()).locale).toBe('ja')
  })

  it('uses the default locale when nothing names a supported one', async () => {
    headerValues = { 'accept-language': 'fr, de;q=0.5' }
    expect((await requestConfig()).locale).toBe('en')
    headerValues = {}
    expect((await requestConfig()).locale).toBe('en')
  })

  it('serves the locale’s own messages where the brand overrides none', async () => {
    const config = await requestConfig()
    expect(config.messages).toEqual(en)
  })

  it('merges the brand’s messages over the locale’s', async () => {
    cookieLocale = 'ja'
    const { messages } = await requestConfig()
    expect(messages.brandOnly).toEqual({ greeting: 'ようこそ' })
    expect(messages.common).toEqual(ja.common)
  })

  it('gives the time zone the deployment set', async () => {
    expect((await requestConfig()).timeZone).toBe('Europe/London')
  })
})
