import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import {
  KukanError,
  NotFoundError,
  ValidationError,
  RequestAbandonedError,
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

  it("should convert Hono's own refusals to RFC 7807 rather than 500", async () => {
    const app = createTestApp(() => {
      throw new HTTPException(400, { message: 'Malformed JSON in request body' })
    })

    const res = await app.request('/test')
    expect(res.status).toBe(400)

    const body = await res.json()
    expect(body).toEqual({
      type: 'about:blank',
      title: 'VALIDATION_ERROR',
      status: 400,
      detail: 'Malformed JSON in request body',
    })
  })

  it('should keep the response an HTTPException carried', async () => {
    const app = createTestApp(() => {
      throw new HTTPException(401, {
        res: new Response('custom', { status: 401, headers: { 'X-Test': '1' } }),
      })
    })

    const res = await app.request('/test')
    expect(res.status).toBe(401)
    expect(res.headers.get('X-Test')).toBe('1')
    expect(await res.text()).toBe('custom')
  })

  it('should report an HTTPException with a status it cannot describe as 500', async () => {
    const app = createTestApp(() => {
      throw new HTTPException(418, { message: "I'm a teapot" })
    })

    const res = await app.request('/test')
    expect(res.status).toBe(500)
    expect((await res.json()).detail).toBe('An unexpected error occurred')
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

  it('should report a Better Auth refusal under the code the auth API answers with', async () => {
    // Unmapped, every refusal from auth.api — a weak password, an email
    // already taken — was reported and logged as an unexpected 500
    const app = createTestApp(() => {
      throw Object.assign(new Error('Password is too easy to guess'), {
        name: 'APIError',
        statusCode: 400,
        body: { code: 'PASSWORD_TOO_WEAK', message: 'Password is too easy to guess' },
      })
    })

    const res = await app.request('/test')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      title: 'PASSWORD_TOO_WEAK',
      status: 400,
      detail: 'Password is too easy to guess',
    })
  })

  it('should leave an APIError with a status it cannot describe to the 500 fallback', async () => {
    const app = createTestApp(() => {
      throw Object.assign(new Error('teapot'), { name: 'APIError', statusCode: 418 })
    })

    const res = await app.request('/test')
    expect(res.status).toBe(500)
    expect((await res.json()).detail).toBe('An unexpected error occurred')
  })

  it('should convert RequestAbandonedError to 408 without logging a fault', async () => {
    // A request its caller withdrew is answered by the class, not by reading
    // the request: a genuine crash that coincides with someone navigating away
    // must still be a logged 500.
    const logged: unknown[] = []
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('logger', {
        ...createLogger({ name: 'test', level: 'silent' }),
        error: (...args: unknown[]) => logged.push(args),
      })
      await next()
    })
    app.onError(errorHandler)
    app.get('/test', () => {
      throw new RequestAbandonedError()
    })

    const res = await app.request('/test')

    expect(res.status).toBe(408)
    expect((await res.json()).title).toBe('REQUEST_ABANDONED')
    expect(logged).toHaveLength(0)
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
