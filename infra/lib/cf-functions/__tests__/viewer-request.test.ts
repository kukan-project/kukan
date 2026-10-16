import { describe, it, expect } from 'vitest'
import { loadViewerRequestCode } from '../inject'

/**
 * The CF Function is plain JS injected with config at synth time. We exercise the
 * *real* injected source (via loadViewerRequestCode) by evaluating it and calling
 * handler(), so both the injection (cdn glue) and the runtime logic are covered.
 */

interface CfResult {
  statusCode?: number
  statusDescription?: string
  headers?: Record<string, { value: string }>
  cookies?: Record<string, { value?: string }>
}
type Handler = (event: unknown) => CfResult

function makeHandler(
  allowedIpRanges?: string[],
  basicAuth?: { username: string; password: string }
): Handler {
  // new Function is safe here: `src` is our own repo file + test-literal config, never user input.
  const src = loadViewerRequestCode(allowedIpRanges, basicAuth)
  return new Function('event', `${src}\nreturn handler(event)`) as Handler
}

function event(
  ip: string,
  opts: { auth?: string; cookies?: Record<string, unknown>; headers?: Record<string, string> } = {}
): unknown {
  const headers: Record<string, { value: string }> = {}
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k] = { value: v }
  if (opts.auth) headers.authorization = { value: opts.auth }
  return {
    viewer: { ip },
    request: { cookies: opts.cookies ?? {}, headers },
  }
}

const basicHeader = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`

/** A forwarded request has no statusCode (the function returns event.request). */
const forwarded = (r: CfResult) => r.statusCode === undefined

describe('viewer-request access control', () => {
  describe('open (neither gate configured)', () => {
    it('forwards any request', () => {
      const h = makeHandler()
      expect(forwarded(h(event('8.8.8.8')))).toBe(true)
    })
  })

  describe('IP allowlist only', () => {
    const h = makeHandler(['203.0.113.0/24', '2001:db8::/32'])

    it('forwards an allowed IPv4', () => {
      expect(forwarded(h(event('203.0.113.5')))).toBe(true)
    })
    it('rejects a denied IPv4 with 403', () => {
      expect(h(event('8.8.8.8')).statusCode).toBe(403)
    })
    it('forwards an allowed IPv6 (CIDR + :: expansion)', () => {
      expect(forwarded(h(event('2001:db8::1')))).toBe(true)
    })
    it('rejects a denied IPv6 with 403', () => {
      expect(h(event('2002::1')).statusCode).toBe(403)
    })
  })

  describe('Basic auth only', () => {
    const h = makeHandler(undefined, { username: 'preview', password: 'secret' })
    const good = basicHeader('preview', 'secret')

    it('forwards with valid credentials', () => {
      expect(forwarded(h(event('8.8.8.8', { auth: good })))).toBe(true)
    })
    it('rejects missing credentials with 401 + WWW-Authenticate', () => {
      const r = h(event('8.8.8.8'))
      expect(r.statusCode).toBe(401)
      expect(r.headers?.['www-authenticate'].value).toContain('Basic')
    })
    it('rejects wrong credentials with 401', () => {
      expect(h(event('8.8.8.8', { auth: basicHeader('preview', 'wrong') })).statusCode).toBe(401)
    })
  })

  describe('IP allowlist OR Basic auth (both configured)', () => {
    const h = makeHandler(['203.0.113.0/24'], { username: 'preview', password: 'secret' })
    const good = basicHeader('preview', 'secret')

    it('forwards an allowed IP without credentials', () => {
      expect(forwarded(h(event('203.0.113.5')))).toBe(true)
    })
    it('forwards a denied IP with valid credentials', () => {
      expect(forwarded(h(event('8.8.8.8', { auth: good })))).toBe(true)
    })
    it('forwards an allowed IP even with wrong credentials (IP wins)', () => {
      expect(forwarded(h(event('203.0.113.5', { auth: 'Basic nope' })))).toBe(true)
    })
    it('returns 401 (not 403) for a denied IP without credentials', () => {
      expect(h(event('8.8.8.8')).statusCode).toBe(401)
    })
  })

  describe('cookie-based cache bypass', () => {
    const h = makeHandler() // open, so the request is forwarded and we can inspect headers

    it('injects x-cache-bypass for a session cookie', () => {
      const r = h(event('8.8.8.8', { cookies: { 'better-auth.session_token': { value: 'x' } } }))
      expect(r.headers?.['x-cache-bypass']).toBeDefined()
    })
    it('matches the bare session_token cookie name', () => {
      const r = h(event('8.8.8.8', { cookies: { session_token: { value: 'x' } } }))
      expect(r.headers?.['x-cache-bypass']).toBeDefined()
    })
    it('does NOT match a substring-injection cookie (xsession_tokenx)', () => {
      const r = h(event('8.8.8.8', { cookies: { xsession_tokenx: { value: 'x' } } }))
      expect(r.headers?.['x-cache-bypass']).toBeUndefined()
    })
    it('leaves requests without a session cookie untouched', () => {
      const r = h(event('8.8.8.8', { cookies: { other: { value: 'x' } } }))
      expect(r.headers?.['x-cache-bypass']).toBeUndefined()
    })
  })

  describe('locale header', () => {
    const h = makeHandler()
    const locale = (opts: Parameters<typeof event>[1]) =>
      h(event('8.8.8.8', opts)).headers?.['x-kukan-locale']?.value

    it('takes the NEXT_LOCALE cookie first', () => {
      expect(
        locale({ cookies: { NEXT_LOCALE: { value: 'ja' } }, headers: { 'accept-language': 'en' } })
      ).toBe('ja')
    })
    it('ignores an unsupported cookie value and falls through to Accept-Language', () => {
      expect(
        locale({ cookies: { NEXT_LOCALE: { value: 'fr' } }, headers: { 'accept-language': 'ja' } })
      ).toBe('ja')
    })
    it('picks the highest-q supported tag, matching on the primary subtag', () => {
      expect(locale({ headers: { 'accept-language': 'fr;q=0.9, en-US;q=0.5, ja-JP;q=0.8' } })).toBe(
        'ja'
      )
    })
    it('keeps header order between equal q values', () => {
      expect(locale({ headers: { 'accept-language': 'ja, en' } })).toBe('ja')
    })
    it('falls back to the default locale', () => {
      expect(locale({ headers: { 'accept-language': 'fr, de' } })).toBe('en')
      expect(locale({})).toBe('en')
    })
    it('overwrites a viewer-sent value', () => {
      expect(locale({ headers: { 'x-kukan-locale': 'fr', 'accept-language': 'ja' } })).toBe('ja')
    })
  })
})
