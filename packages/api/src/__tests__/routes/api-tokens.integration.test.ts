import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createTestApp } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'

const db = getTestDb()
const app = createTestApp(db)
const unauthApp = createTestApp(db, { user: null })

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
})

afterAll(async () => {
  await closeTestDb()
})

describe('API Tokens API', () => {
  describe('POST /api/v1/api-tokens', () => {
    it('should create a token and return it', async () => {
      const res = await app.request('/api/v1/api-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'CI Token' }),
      })
      expect(res.status).toBe(201)

      const body = await res.json()
      expect(body.token).toBeDefined()
      expect(body.token).toMatch(/^kukan_/)
      expect(body.id).toBeDefined()
    })

    it('should create a token with expiration', async () => {
      const res = await app.request('/api/v1/api-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Expiring', expiresInDays: 30 }),
      })
      expect(res.status).toBe(201)

      const body = await res.json()
      expect(body.token).toBeDefined()
    })

    it('should create a token without name', async () => {
      const res = await app.request('/api/v1/api-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(201)
    })

    it('should return 401 for unauthenticated request', async () => {
      const res = await unauthApp.request('/api/v1/api-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test' }),
      })
      expect(res.status).toBe(401)
    })
  })

  describe('GET /api/v1/api-tokens', () => {
    it('should return empty list initially', async () => {
      const res = await app.request('/api/v1/api-tokens')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.items).toEqual([])
    })

    it('should list created tokens', async () => {
      // Create two tokens
      await app.request('/api/v1/api-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Token A' }),
      })
      await app.request('/api/v1/api-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Token B' }),
      })

      const res = await app.request('/api/v1/api-tokens')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.items).toHaveLength(2)
      // Token values should NOT be returned in list
      expect(body.items[0].token).toBeUndefined()
    })

    it('should return 401 for unauthenticated request', async () => {
      const res = await unauthApp.request('/api/v1/api-tokens')
      expect(res.status).toBe(401)
    })
  })

  describe('DELETE /api/v1/api-tokens/:id', () => {
    it('should revoke a token', async () => {
      // Create a token
      const createRes = await app.request('/api/v1/api-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'To Delete' }),
      })
      const { id } = await createRes.json()

      // Delete it
      const deleteRes = await app.request(`/api/v1/api-tokens/${id}`, {
        method: 'DELETE',
      })
      expect(deleteRes.status).toBe(200)

      // Verify it's gone
      const listRes = await app.request('/api/v1/api-tokens')
      const body = await listRes.json()
      expect(body.items).toHaveLength(0)
    })

    it('should return 404 for non-existent token', async () => {
      const res = await app.request('/api/v1/api-tokens/00000000-0000-0000-0000-000000000099', {
        method: 'DELETE',
      })
      expect(res.status).toBe(404)
    })

    it('should return 401 for unauthenticated request', async () => {
      const res = await unauthApp.request(
        '/api/v1/api-tokens/00000000-0000-0000-0000-000000000099',
        {
          method: 'DELETE',
        }
      )
      expect(res.status).toBe(401)
    })
  })
})
