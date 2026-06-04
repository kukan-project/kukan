import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { cacheControl, publicCache, noCache } from '../../middleware/cache-control'

function createApp() {
  const app = new Hono()
  app.use('*', cacheControl)
  return app
}

describe('cacheControl (default middleware)', () => {
  it('should set private, no-cache for GET', async () => {
    const app = createApp()
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
  })

  it('should set private, no-cache for HEAD', async () => {
    const app = createApp()
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test', { method: 'HEAD' })
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
  })

  it('should set private, no-store for POST', async () => {
    const app = createApp()
    app.post('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test', { method: 'POST' })
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('should set private, no-store for PUT', async () => {
    const app = createApp()
    app.put('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test', { method: 'PUT' })
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('should set private, no-store for DELETE', async () => {
    const app = createApp()
    app.delete('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test', { method: 'DELETE' })
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('should not overwrite existing Cache-Control', async () => {
    const app = createApp()
    app.get('/test', (_c) => {
      return new Response('ok', {
        headers: { 'Cache-Control': 'private, max-age=300' },
      })
    })

    const res = await app.request('/test')
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=300')
  })
})

describe('publicCache', () => {
  it('should set public cache with default values', async () => {
    const app = createApp()
    app.get('/test', publicCache(), (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.headers.get('Cache-Control')).toBe(
      'public, max-age=60, stale-while-revalidate=300'
    )
  })

  it('should set public cache with custom values', async () => {
    const app = createApp()
    app.get('/test', publicCache(3600, 86400), (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.headers.get('Cache-Control')).toBe(
      'public, max-age=3600, stale-while-revalidate=86400'
    )
  })

  it('should override default cache-control', async () => {
    const app = createApp()
    app.get('/test', publicCache(), (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    // publicCache runs after cacheControl, so it overrides the default
    expect(res.headers.get('Cache-Control')).not.toContain('private')
  })

  it('should not apply public cache on error responses', async () => {
    const app = createApp()
    app.get('/test', publicCache(), (c) => c.json({ error: 'not found' }, 404))

    const res = await app.request('/test')
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
  })

  it('should not apply public cache on 500 errors', async () => {
    const app = createApp()
    app.get('/test', publicCache(), (c) => c.json({ error: 'internal' }, 500))

    const res = await app.request('/test')
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
  })
})

describe('noCache', () => {
  it('should set no-cache without private', async () => {
    const app = createApp()
    app.get('/test', noCache(), (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.headers.get('Cache-Control')).toBe('no-cache')
  })
})
