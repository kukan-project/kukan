import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { PayloadTooLargeError } from '@kukan/shared'
import { errorHandler } from '../../middleware/error-handler'
import { retireConnection } from '../../middleware/retire-connection'

/** An upload route shaped like the real one: answered through the error handler. */
function createApp(handler: () => unknown) {
  const app = new Hono()
  app.onError(errorHandler)
  app.post('/upload', retireConnection(), (c) => {
    handler()
    return c.json({ ok: true })
  })
  return app.request('/upload', { method: 'POST', body: 'x' })
}

describe('retireConnection', () => {
  it('retires the connection when the upload is refused on its size', async () => {
    const res = await createApp(() => {
      throw new PayloadTooLargeError('too large')
    })

    expect(res.status).toBe(413)
    expect(res.headers.get('Connection')).toBe('close')
  })

  it('retires the connection when the refusal carries its own response', async () => {
    // The error handler answers these before it reaches its own rendering, so
    // a header added there would miss them.
    const res = await createApp(() => {
      throw new HTTPException(413, { res: new Response('nope', { status: 413 }) })
    })

    expect(res.status).toBe(413)
    expect(res.headers.get('Connection')).toBe('close')
  })

  it('leaves the connection alone when the upload is accepted', async () => {
    const res = await createApp(() => {})

    expect(res.status).toBe(200)
    expect(res.headers.get('Connection')).toBeNull()
  })
})
