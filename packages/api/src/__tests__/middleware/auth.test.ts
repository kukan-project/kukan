import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createLogger, SESSION_COOKIE_NAME } from '@kukan/shared'
import { optionalAuth, requireAuth, requireSysadmin } from '../../middleware/auth'
import { errorHandler } from '../../middleware/error-handler'

// Mock ApiTokenService
const mockValidate = vi.fn()
vi.mock('../../services/api-token-service', () => ({
  ApiTokenService: function () {
    return { validate: mockValidate }
  },
}))

// Mock auth object
function createMockAuth(sessionUser: Record<string, unknown> | null = null) {
  return {
    api: {
      getSession: vi.fn().mockResolvedValue(sessionUser ? { user: sessionUser } : null),
    },
  } as never
}

function createTestApp(middleware: ReturnType<typeof optionalAuth>) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('logger', createLogger({ name: 'test', level: 'silent' }))
    c.set('db', {}) // mock db
    await next()
  })
  app.onError(errorHandler)
  app.use('/test', middleware)
  app.get('/test', (c) => {
    const user = c.get('user')
    return c.json({ user: user ?? null })
  })
  return app
}

describe('optionalAuth', () => {
  beforeEach(() => {
    mockValidate.mockReset()
  })

  it('should set user from session cookie', async () => {
    const auth = createMockAuth({
      id: 'u1',
      email: 'user@test.com',
      name: 'testuser',
      displayName: 'Test User',
      role: 'user',
      state: 'active',
    })
    const app = createTestApp(optionalAuth(auth))

    const res = await app.request('/test', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=abc123` },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user).toEqual({
      id: 'u1',
      email: 'user@test.com',
      name: 'testuser',
      displayName: 'Test User',
      sysadmin: false,
    })
  })

  it('should set sysadmin true for sysadmin role', async () => {
    const auth = createMockAuth({
      id: 'u1',
      email: 'admin@test.com',
      name: 'admin',
      displayName: null,
      role: 'sysadmin',
      state: 'active',
    })
    const app = createTestApp(optionalAuth(auth))

    const res = await app.request('/test', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=abc123` },
    })

    const body = await res.json()
    expect(body.user.sysadmin).toBe(true)
  })

  it('should skip deleted users even with valid session', async () => {
    const auth = createMockAuth({
      id: 'u1',
      email: 'deleted@test.com',
      name: 'deleted',
      role: 'user',
      state: 'deleted',
    })
    const app = createTestApp(optionalAuth(auth))

    const res = await app.request('/test', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=abc123` },
    })

    const body = await res.json()
    expect(body.user).toBeNull()
  })

  it('should set user from Bearer API token', async () => {
    const auth = createMockAuth(null) // no session
    mockValidate.mockResolvedValue({
      id: 'u2',
      email: 'api@test.com',
      name: 'apiuser',
      displayName: null,
      sysadmin: false,
    })
    const app = createTestApp(optionalAuth(auth))

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer kukan_abc123' },
    })

    const body = await res.json()
    expect(body.user).toEqual({
      id: 'u2',
      email: 'api@test.com',
      name: 'apiuser',
      displayName: null,
      sysadmin: false,
    })
  })

  it('should not set user when no credentials provided', async () => {
    const auth = createMockAuth(null)
    const app = createTestApp(optionalAuth(auth))

    const res = await app.request('/test')

    const body = await res.json()
    expect(body.user).toBeNull()
  })

  it('should handle session validation error gracefully', async () => {
    const auth = {
      api: {
        getSession: vi.fn().mockRejectedValue(new Error('session expired')),
      },
    } as never
    const app = createTestApp(optionalAuth(auth))

    const res = await app.request('/test', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=expired` },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user).toBeNull()
  })

  it('should handle API token validation error gracefully', async () => {
    const auth = createMockAuth(null)
    mockValidate.mockRejectedValue(new Error('db error'))
    const app = createTestApp(optionalAuth(auth))

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer kukan_invalid' },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user).toBeNull()
  })

  it('should check __Secure- prefixed cookie', async () => {
    const auth = createMockAuth({
      id: 'u1',
      email: 'secure@test.com',
      name: 'secure',
      displayName: null,
      role: 'user',
      state: 'active',
    })
    const app = createTestApp(optionalAuth(auth))

    const res = await app.request('/test', {
      headers: { cookie: `__Secure-${SESSION_COOKIE_NAME}=abc123` },
    })

    const body = await res.json()
    expect(body.user).not.toBeNull()
    expect(body.user.email).toBe('secure@test.com')
  })

  it('should prefer session cookie over API token', async () => {
    const auth = createMockAuth({
      id: 'session-user',
      email: 'session@test.com',
      name: 'session',
      displayName: null,
      role: 'user',
      state: 'active',
    })
    mockValidate.mockResolvedValue({
      id: 'token-user',
      email: 'token@test.com',
      name: 'token',
      displayName: null,
      sysadmin: false,
    })
    const app = createTestApp(optionalAuth(auth))

    const res = await app.request('/test', {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=abc123`,
        Authorization: 'Bearer kukan_xyz',
      },
    })

    const body = await res.json()
    expect(body.user.id).toBe('session-user')
  })
})

describe('requireAuth', () => {
  it('should return 401 when not authenticated', async () => {
    const auth = createMockAuth(null)
    const app = createTestApp(requireAuth(auth))

    const res = await app.request('/test')

    expect(res.status).toBe(401)
  })

  it('should allow authenticated users', async () => {
    const auth = createMockAuth({
      id: 'u1',
      email: 'user@test.com',
      name: 'user',
      displayName: null,
      role: 'user',
      state: 'active',
    })
    const app = createTestApp(requireAuth(auth))

    const res = await app.request('/test', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=abc123` },
    })

    expect(res.status).toBe(200)
  })
})

describe('requireSysadmin', () => {
  it('should return 403 for non-sysadmin users', async () => {
    const auth = createMockAuth({
      id: 'u1',
      email: 'user@test.com',
      name: 'user',
      displayName: null,
      role: 'user',
      state: 'active',
    })
    const app = createTestApp(requireSysadmin(auth))

    const res = await app.request('/test', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=abc123` },
    })

    expect(res.status).toBe(403)
  })

  it('should allow sysadmin users', async () => {
    const auth = createMockAuth({
      id: 'u1',
      email: 'admin@test.com',
      name: 'admin',
      displayName: null,
      role: 'sysadmin',
      state: 'active',
    })
    const app = createTestApp(requireSysadmin(auth))

    const res = await app.request('/test', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=abc123` },
    })

    expect(res.status).toBe(200)
  })

  it('should return 401 when not authenticated', async () => {
    const auth = createMockAuth(null)
    const app = createTestApp(requireSysadmin(auth))

    const res = await app.request('/test')

    expect(res.status).toBe(401)
  })
})
