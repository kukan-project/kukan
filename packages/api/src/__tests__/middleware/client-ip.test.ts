import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { EDGE_CLIENT_IP_HEADER, type Env } from '@kukan/shared'
import { callerOf, clientIp } from '../../middleware/client-ip'

/** An app that answers with what `clientIp` and `callerOf` read, under the header `env` names. */
function appReading(header: Env['CLIENT_IP_HEADER'], userId?: string) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('env', { CLIENT_IP_HEADER: header } as Env)
    if (userId) {
      c.set('user', {
        id: userId,
        email: '',
        name: '',
        displayName: null,
        sysadmin: false,
        authMethod: 'session',
      })
    }
    await next()
  })
  app.get('/', (c) => c.json({ ip: clientIp(c) ?? null, caller: callerOf(c) }))
  return app
}

async function read(header: Env['CLIENT_IP_HEADER'], headers: Record<string, string>) {
  const res = await appReading(header).request('/', { headers })
  return ((await res.json()) as { ip: string | null }).ip
}

describe('clientIp', () => {
  it('reads the first address of X-Forwarded-For', async () => {
    expect(await read('x-forwarded-for', { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' })).toBe(
      '203.0.113.5'
    )
  })

  it('reads the edge header where the env names it, and not X-Forwarded-For', async () => {
    expect(
      await read(EDGE_CLIENT_IP_HEADER, {
        [EDGE_CLIENT_IP_HEADER]: '2001:db8::1',
        'x-forwarded-for': '203.0.113.5',
      })
    ).toBe('2001:db8::1')
    expect(await read(EDGE_CLIENT_IP_HEADER, { 'x-forwarded-for': '203.0.113.5' })).toBeNull()
  })

  it('answers undefined with no header, or one that holds no address', async () => {
    expect(await read('x-forwarded-for', {})).toBeNull()
    expect(await read('x-forwarded-for', { 'x-forwarded-for': 'unknown' })).toBeNull()
    expect(await read('x-forwarded-for', { 'x-forwarded-for': '' })).toBeNull()
  })
})

describe('callerOf', () => {
  async function caller(userId: string | undefined, headers: Record<string, string>) {
    const res = await appReading('x-forwarded-for', userId).request('/', { headers })
    return ((await res.json()) as { caller: { userId?: string; ip?: string } }).caller
  }

  it('names the signed-in user and the address', async () => {
    expect(await caller('u1', { 'x-forwarded-for': '203.0.113.5' })).toEqual({
      userId: 'u1',
      ip: '203.0.113.5',
    })
  })

  it('leaves out what the request does not carry', async () => {
    expect(await caller(undefined, { 'x-forwarded-for': '203.0.113.5' })).toEqual({
      ip: '203.0.113.5',
    })
    expect(await caller(undefined, {})).toEqual({})
  })
})
