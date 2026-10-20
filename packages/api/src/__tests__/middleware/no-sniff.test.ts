import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { NotFoundError } from '@kukan/shared'
import { noSniff } from '../../middleware/no-sniff'
import { errorHandler } from '../../middleware/error-handler'

function createApp() {
  const app = new Hono()
  app.use('*', noSniff)
  app.onError(errorHandler)
  return app
}

describe('noSniff', () => {
  it('should mark a text response nosniff', async () => {
    const app = createApp()
    app.get('/text', (c) => c.text('<html><script>alert(1)</script>'))

    const res = await app.request('/text')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('should mark a raw Response a handler returns, even one with immutable headers', async () => {
    const app = createApp()
    app.get('/raw', () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }))
    app.get('/redirect', () => Response.redirect('https://example.com/', 302))

    for (const path of ['/raw', '/redirect']) {
      const res = await app.request(path)
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    }
  })

  it('should mark error responses too', async () => {
    const app = createApp()
    app.get('/missing', () => {
      throw new NotFoundError('Resource', 'x')
    })

    const res = await app.request('/missing')
    expect(res.status).toBe(404)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})
