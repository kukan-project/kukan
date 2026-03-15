import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { KukanError, NotFoundError, ValidationError } from '@kukan/shared'
import { errorHandler } from '../../middleware/error-handler'

function createTestApp(thrower: () => never) {
  const app = new Hono()
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

  it('should convert unknown errors to 500 RFC 7807', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

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
})
