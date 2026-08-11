import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { authSurface } from '../../middleware/auth-surface'
import { errorHandler } from '../../middleware/error-handler'

/** Stands in for the Better Auth handler: a request that reaches it is one the
 *  guard let through. */
function createApp() {
  const handler = vi.fn(() => new Response('{"ok":true}', { status: 200 }))
  const app = new Hono()
  app.use('/api/auth/*', authSurface)
  app.all('/api/auth/*', handler)
  app.onError(errorHandler)
  return { app, handler }
}

const BLOCKED = ['/api/auth/update-user', '/api/auth/admin/set-role']

// sign-in/email is nested, so it also catches a rule sloppy about prefixes
const ALLOWED = ['/api/auth/sign-in/email', '/api/auth/get-session', '/api/auth/change-password']

describe('authSurface', () => {
  it.each(BLOCKED)('answers 404 for %s without reaching the handler', async (path) => {
    const { app, handler } = createApp()

    const res = await app.request(path, { method: 'POST' })

    expect(res.status).toBe(404)
    expect(handler).not.toHaveBeenCalled()
  })

  it.each(ALLOWED)('passes %s through', async (path) => {
    const { app, handler } = createApp()

    const res = await app.request(path, { method: 'POST' })

    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('reports the block as a Problem Details 404, not as a refusal', async () => {
    const { app } = createApp()

    const res = await app.request('/api/auth/update-user', { method: 'POST' })

    // 403 would confirm the endpoint exists; the point is to not advertise it
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'NOT_FOUND',
      status: 404,
      detail: 'The requested resource was not found',
    })
  })
})
