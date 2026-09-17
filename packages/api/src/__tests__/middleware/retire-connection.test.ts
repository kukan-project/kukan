import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { PayloadTooLargeError } from '@kukan/shared'
import { errorHandler } from '../../middleware/error-handler'
import { retireConnection } from '../../middleware/retire-connection'

/** The app shape this is mounted in: global middleware, real error handler. */
function createApp() {
  const app = new Hono()
  app.use('*', retireConnection)
  app.onError(errorHandler)
  return app
}

/** An upload, as far as the middleware can tell — a multipart request body. */
function upload(app: Hono, path = '/upload') {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=x' },
    body: '--x--',
  })
}

describe('retireConnection', () => {
  it('retires the connection when an upload is refused', async () => {
    const app = createApp()
    app.post('/upload', () => {
      throw new PayloadTooLargeError('too large')
    })

    const res = await upload(app)
    expect(res.status).toBe(413)
    expect(res.headers.get('Connection')).toBe('close')
  })

  it('retires the connection when the refusal carries its own response', async () => {
    // The error handler answers these before it renders anything of its own,
    // so a header added there would miss them.
    const app = createApp()
    app.post('/upload', () => {
      throw new HTTPException(413, { res: new Response('nope', { status: 413 }) })
    })

    const res = await upload(app)
    expect(res.status).toBe(413)
    expect(res.headers.get('Connection')).toBe('close')
  })

  it('retires the connection for an upload to a path that matches nothing', async () => {
    // Answered without a route, so nothing route-scoped could have spoken for
    // it — and a mistyped upload URL streams just as many bytes.
    const res = await upload(createApp(), '/mistyped')

    expect(res.status).toBe(404)
    expect(res.headers.get('Connection')).toBe('close')
  })

  it('leaves the connection alone when the upload is accepted', async () => {
    const app = createApp()
    app.post('/upload', (c) => c.json({ ok: true }))

    const res = await upload(app)
    expect(res.status).toBe(200)
    expect(res.headers.get('Connection')).toBeNull()
  })

  it('leaves the connection alone when the refused request is not an upload', async () => {
    // Every other refusal in the API arrives here: a JSON body the route read
    // to the end, or no body at all. Hanging up on those would retire a
    // connection per validation error.
    const app = createApp()
    app.post('/json', () => {
      throw new PayloadTooLargeError('too large')
    })

    const res = await app.request('/json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(413)
    expect(res.headers.get('Connection')).toBeNull()
  })
})
