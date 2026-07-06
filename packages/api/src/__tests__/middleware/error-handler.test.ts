import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import {
  KukanError,
  NotFoundError,
  ValidationError,
  RequestTimeoutError,
  TooManyRequestsError,
  ServiceUnavailableError,
  createLogger,
} from '@kukan/shared'
import { errorHandler } from '../../middleware/error-handler'

function createTestApp(thrower: () => never) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('logger', createLogger({ name: 'test', level: 'silent' }))
    await next()
  })
  app.onError(errorHandler)
  app.get('/test', () => thrower())
  return app
}

describe('errorHandler', () => {
  it('should convert KukanError to RFC 7807 response', async () => {
    const app = createTestApp(() => {
      throw new KukanError('Custom error', 'CUSTOM', 422, { field: 'test' })
    })

    const res = await app.request('/test')
    expect(res.status).toBe(422)

    const body = await res.json()
    expect(body).toEqual({
      type: 'about:blank',
      title: 'CUSTOM',
      status: 422,
      detail: 'Custom error',
      details: { field: 'test' },
    })
  })

  it('should convert NotFoundError to 404 RFC 7807', async () => {
    const app = createTestApp(() => {
      throw new NotFoundError('Package', 'my-dataset')
    })

    const res = await app.request('/test')
    expect(res.status).toBe(404)

    const body = await res.json()
    expect(body.title).toBe('NOT_FOUND')
    expect(body.detail).toBe('Package not found: my-dataset')
  })

  it('should convert ValidationError to 400 RFC 7807', async () => {
    const app = createTestApp(() => {
      throw new ValidationError('Invalid name', { name: 'bad' })
    })

    const res = await app.request('/test')
    expect(res.status).toBe(400)

    const body = await res.json()
    expect(body.title).toBe('VALIDATION_ERROR')
    expect(body.details).toEqual({ name: 'bad' })
  })

  it('should convert RequestTimeoutError to 408 RFC 7807', async () => {
    const app = createTestApp(() => {
      throw new RequestTimeoutError('Query exceeded the time limit')
    })

    const res = await app.request('/test')
    expect(res.status).toBe(408)

    const body = await res.json()
    expect(body.title).toBe('REQUEST_TIMEOUT')
  })

  it('should convert TooManyRequestsError to 429 RFC 7807', async () => {
    const app = createTestApp(() => {
      throw new TooManyRequestsError('Too many concurrent queries')
    })

    const res = await app.request('/test')
    expect(res.status).toBe(429)

    const body = await res.json()
    expect(body.title).toBe('TOO_MANY_REQUESTS')
  })

  it('should convert ServiceUnavailableError to 503 RFC 7807', async () => {
    const app = createTestApp(() => {
      throw new ServiceUnavailableError('Search is temporarily unavailable')
    })

    const res = await app.request('/test')
    expect(res.status).toBe(503)

    const body = await res.json()
    expect(body.title).toBe('SERVICE_UNAVAILABLE')
    expect(body.detail).toBe('Search is temporarily unavailable')
  })

  it('should convert unknown errors to 500 RFC 7807', async () => {
    const app = createTestApp(() => {
      throw new Error('unexpected')
    })

    const res = await app.request('/test')
    expect(res.status).toBe(500)

    const body = await res.json()
    expect(body.title).toBe('INTERNAL_SERVER_ERROR')
    expect(body.detail).toBe('An unexpected error occurred')
  })

  it('should omit details when not present on KukanError', async () => {
    const app = createTestApp(() => {
      throw new KukanError('No details', 'NO_DETAILS', 400)
    })

    const res = await app.request('/test')
    const body = await res.json()
    expect(body).not.toHaveProperty('details')
  })

  it('should map a KukanError thrown by another module instance (instanceof fails)', async () => {
    // Simulates a dev-server module-generation split: same shape, different class
    class ForeignKukanError extends Error {
      constructor(
        message: string,
        public readonly code: string,
        public readonly status: number
      ) {
        super(message)
        this.name = 'KukanError'
      }
    }
    const app = createTestApp(() => {
      throw new ForeignKukanError('Search is temporarily unavailable', 'SERVICE_UNAVAILABLE', 503)
    })

    const res = await app.request('/test')
    expect(res.status).toBe(503)

    const body = await res.json()
    expect(body.title).toBe('SERVICE_UNAVAILABLE')
  })

  it('should not map shape-alike third-party errors without the KukanError name', async () => {
    class LibraryError extends Error {
      code = 'ECONNRESET'
      status = 503
    }
    const app = createTestApp(() => {
      throw new LibraryError('internal detail that must not leak')
    })

    const res = await app.request('/test')
    expect(res.status).toBe(500)

    const body = await res.json()
    expect(body.detail).toBe('An unexpected error occurred')
  })

  it('should not map shape-alike errors with unknown status codes', async () => {
    class OddError extends Error {
      code = 'SOMETHING'
      status = 418
      constructor(message: string) {
        super(message)
        this.name = 'KukanError'
      }
    }
    const app = createTestApp(() => {
      throw new OddError('teapot')
    })

    const res = await app.request('/test')
    expect(res.status).toBe(500)
  })

  it('should use fallback logger when context logger is not set', async () => {
    // Error handler should not crash when c.get('logger') is undefined
    // (e.g. error thrown before context middleware runs)
    const app = new Hono()
    // No logger middleware — c.get('logger') returns undefined
    app.onError(errorHandler)
    app.get('/test', () => {
      throw new Error('early error')
    })

    const res = await app.request('/test')
    expect(res.status).toBe(500)

    const body = await res.json()
    expect(body.title).toBe('INTERNAL_SERVER_ERROR')
  })
})
