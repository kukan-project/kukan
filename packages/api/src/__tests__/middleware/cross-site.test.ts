import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { SESSION_COOKIE_NAME } from '@kukan/shared'
import { refuseCrossSite } from '../../middleware/cross-site'
import { errorHandler } from '../../middleware/error-handler'

const app = new Hono()
app.onError(errorHandler)
app.use('*', refuseCrossSite(['https://trusted.example']))
app.all('/', (c) => c.text('ok'))

const session = { Cookie: `__Secure-${SESSION_COOKIE_NAME}=abc` }

async function status(method: string, headers: Record<string, string>) {
  return (await app.request('/', { method, headers })).status
}

describe('refuseCrossSite', () => {
  it.each([
    ['POST', 'same-site'],
    ['POST', 'cross-site'],
    ['DELETE', 'same-site'],
  ])('refuses a %s with the session cookie from a %s page', async (method, site) => {
    expect(await status(method, { ...session, 'Sec-Fetch-Site': site })).toBe(403)
  })

  it.each([
    ['from the same origin', { ...session, 'Sec-Fetch-Site': 'same-origin' }],
    ['typed into the address bar', { ...session, 'Sec-Fetch-Site': 'none' }],
    ['without the session cookie', { 'Sec-Fetch-Site': 'cross-site' }],
    ['from a client that does not say', session],
    [
      'from an origin TRUSTED_ORIGINS lets in',
      { ...session, 'Sec-Fetch-Site': 'cross-site', Origin: 'https://trusted.example' },
    ],
  ])('lets a POST through %s', async (_, headers) => {
    expect(await status('POST', headers)).toBe(200)
  })

  it('lets a cross-site GET through', async () => {
    expect(await status('GET', { ...session, 'Sec-Fetch-Site': 'cross-site' })).toBe(200)
  })
})
