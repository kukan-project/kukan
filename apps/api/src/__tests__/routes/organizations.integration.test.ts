import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createTestApp } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const app = createTestApp(db)

beforeEach(async () => {
  await cleanDatabase()
})

afterAll(async () => {
  await closeTestDb()
})

describe('Organizations API Routes', () => {
  describe('GET /api/v1/organizations', () => {
    it('should return empty list', async () => {
      const res = await app.request('/api/v1/organizations')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.items).toEqual([])
      expect(body.total).toBe(0)
    })

    it('should return organizations with pagination', async () => {
      await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'org-one', title: 'Org One' }),
      })
      await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'org-two', title: 'Org Two' }),
      })

      const res = await app.request('/api/v1/organizations')
      const body = await res.json()
      expect(body.total).toBe(2)
      expect(body.items).toHaveLength(2)
    })

    it('should filter by q parameter', async () => {
      await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'tokyo-city', title: 'Tokyo City' }),
      })
      await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'osaka-city', title: 'Osaka City' }),
      })

      const res = await app.request('/api/v1/organizations?q=tokyo')
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0].name).toBe('tokyo-city')
    })
  })

  describe('POST /api/v1/organizations', () => {
    it('should create and return 201', async () => {
      const res = await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'new-org', title: 'New Org' }),
      })
      expect(res.status).toBe(201)

      const body = await res.json()
      expect(body.name).toBe('new-org')
      expect(body.state).toBe('active')
    })

    it('should reject duplicate name', async () => {
      await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'dup-org' }),
      })

      const res = await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'dup-org' }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/v1/organizations/:nameOrId', () => {
    it('should return by name', async () => {
      await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'get-test' }),
      })

      const res = await app.request('/api/v1/organizations/get-test')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.name).toBe('get-test')
    })

    it('should return 404 for non-existent', async () => {
      const res = await app.request('/api/v1/organizations/no-such')
      expect(res.status).toBe(404)
    })
  })

  describe('PUT /api/v1/organizations/:nameOrId', () => {
    it('should update organization', async () => {
      await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'update-org', title: 'Original' }),
      })

      const res = await app.request('/api/v1/organizations/update-org', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated' }),
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.title).toBe('Updated')
    })
  })

  describe('DELETE /api/v1/organizations/:nameOrId', () => {
    it('should soft delete', async () => {
      await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'delete-org' }),
      })

      const res = await app.request('/api/v1/organizations/delete-org', { method: 'DELETE' })
      expect(res.status).toBe(200)

      // Should not appear in list
      const listRes = await app.request('/api/v1/organizations')
      const body = await listRes.json()
      expect(body.total).toBe(0)
    })
  })
})
