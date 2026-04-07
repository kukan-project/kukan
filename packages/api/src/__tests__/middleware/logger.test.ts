import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { Logger } from '@kukan/shared'
import { logger } from '../../middleware/logger'

function createMockLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(),
    level: 'info',
  } as unknown as Logger & { info: ReturnType<typeof vi.fn> }
}

describe('logger middleware', () => {
  it('should log structured request fields', async () => {
    const mockLog = createMockLogger()
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('logger', mockLog)
      await next()
    })
    app.use('*', logger)
    app.get('/api/v1/packages', (c) => c.json({ ok: true }))

    await app.request('/api/v1/packages')

    expect(mockLog.info).toHaveBeenCalledOnce()
    const [fields, message] = mockLog.info.mock.calls[0]
    expect(message).toBe('request completed')
    expect(fields.method).toBe('GET')
    expect(fields.path).toBe('/api/v1/packages')
    expect(fields.status).toBe(200)
    expect(fields.elapsed).toBeTypeOf('number')
    expect(fields.elapsed).toBeGreaterThanOrEqual(0)
  })

  it('should log correct status for error responses', async () => {
    const mockLog = createMockLogger()
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('logger', mockLog)
      await next()
    })
    app.use('*', logger)
    app.get('/not-here', (c) => c.json({ error: 'not found' }, 404))

    await app.request('/not-here')

    const [fields] = mockLog.info.mock.calls[0]
    expect(fields.status).toBe(404)
    expect(fields.method).toBe('GET')
  })

  it('should log POST method correctly', async () => {
    const mockLog = createMockLogger()
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('logger', mockLog)
      await next()
    })
    app.use('*', logger)
    app.post('/api/v1/packages', (c) => c.json({ id: '1' }, 201))

    await app.request('/api/v1/packages', { method: 'POST' })

    const [fields] = mockLog.info.mock.calls[0]
    expect(fields.method).toBe('POST')
    expect(fields.status).toBe(201)
  })
})
