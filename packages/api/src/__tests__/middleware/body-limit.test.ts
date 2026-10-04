import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { Request as UndiciRequest, type RequestInit as UndiciRequestInit } from 'undici'
import { MAX_BODY_BYTES, limitBody } from '../../middleware/body-limit'
import { errorHandler } from '../../middleware/error-handler'

/** Mounted as in the app, with a route that reads its body whole */
function createApp() {
  const app = new Hono()
  app.use('/api/*', limitBody)
  app.onError(errorHandler)
  const handler = vi.fn(async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }))
  app.post('/api/v1/packages', handler)
  app.post('/api/v1/resources/:id/upload', handler)
  return { app, handler }
}

const JSON_TYPE = 'application/json'
const MULTIPART_TYPE = 'multipart/form-data; boundary=x'

/** A body with a declared length, as a client that knows it sends one */
function declared(bytes: number, type = JSON_TYPE, method = 'POST'): RequestInit {
  return {
    method,
    headers: { 'content-type': type, 'content-length': String(bytes) },
    body: 'x'.repeat(bytes),
  }
}

/** A chunked body: no Content-Length, so only counting what arrives can bound it */
function chunked(bytes: number, type = JSON_TYPE, chunkSize = 64 * 1024): RequestInit {
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) return controller.close()
      const n = Math.min(chunkSize, bytes - sent)
      sent += n
      controller.enqueue(new Uint8Array(n))
    },
  })
  return { method: 'POST', headers: { 'content-type': type }, body, duplex: 'half' } as RequestInit
}

const bodies = { declared, chunked }

describe('limitBody', () => {
  it.each(Object.entries(bodies))('passes a %s body at the cap, whole', async (_, body) => {
    const { app } = createApp()
    const res = await app.request('/api/v1/packages', body(MAX_BODY_BYTES))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ bytes: MAX_BODY_BYTES })
  })

  it.each(Object.entries(bodies))(
    'refuses a %s body over the cap before the route reads it',
    async (_, body) => {
      const { app, handler } = createApp()
      const res = await app.request('/api/v1/packages', body(MAX_BODY_BYTES + 1))
      expect(res.status).toBe(413)
      expect(await res.json()).toMatchObject({ title: 'PAYLOAD_TOO_LARGE', status: 413 })
      expect(handler).not.toHaveBeenCalled()
      // The rest of the body is left unread on the connection
      expect(res.headers.get('Connection')).toBe('close')
    }
  )

  it('refuses before the route is matched, so an unknown path is bounded too', async () => {
    const { app } = createApp()
    const res = await app.request('/api/auth/sign-in/email', declared(MAX_BODY_BYTES + 1))
    expect(res.status).toBe(413)
  })

  it.each(Object.entries(bodies))('leaves a %s upload to its own cap', async (_, body) => {
    const { app } = createApp()
    const bytes = 2 * MAX_BODY_BYTES
    const res = await app.request('/api/v1/resources/abc/upload', body(bytes, MULTIPART_TYPE))
    expect(await res.json()).toEqual({ bytes })
  })

  it('bounds what the upload route does not stream', async () => {
    const { app, handler } = createApp()
    const path = '/api/v1/resources/abc/upload'
    const json = await app.request(path, declared(MAX_BODY_BYTES + 1))
    expect(json.status).toBe(413)
    const put = await app.request(path, declared(MAX_BODY_BYTES + 1, MULTIPART_TYPE, 'PUT'))
    expect(put.status).toBe(413)
    expect(handler).not.toHaveBeenCalled()
  })

  // Next.js hands the route a Request of another class than this runtime's
  // global one, npm's undici standing in for it here. A DELETE with nothing to
  // send comes as Next.js gives it: an empty stream with no length.
  it.each([
    ['an empty DELETE', { ...chunked(0), method: 'DELETE' }],
    ['a chunked body', chunked(1024)],
  ])('reads %s on a Request of another class', async (_, init) => {
    const app = new Hono()
    app.use('/api/*', limitBody)
    app.onError(errorHandler)
    const handler = vi.fn(async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }))
    app.on(['POST', 'DELETE'], '/api/v1/packages', handler)
    const req = new UndiciRequest('http://localhost/api/v1/packages', init as UndiciRequestInit)
    const res = await app.fetch(req as unknown as Request)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ bytes: init.method === 'DELETE' ? 0 : 1024 })
  })

  it('bounds what only looks like the upload route', async () => {
    const { app } = createApp()
    const res = await app.request(
      '/api/v1/resources/abc/upload-complete',
      declared(MAX_BODY_BYTES + 1)
    )
    expect(res.status).toBe(413)
  })
})
