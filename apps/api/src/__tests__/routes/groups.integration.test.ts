import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createTestApp } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'

const db = getTestDb()
const app = createTestApp(db)

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
})

afterAll(async () => {
  await closeTestDb()
})

describe('Groups API Routes', () => {
  describe('GET /api/v1/groups', () => {
    it('should return empty list', async () => {
      const res = await app.request('/api/v1/groups')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.items).toEqual([])
      expect(body.total).toBe(0)
    })
  })

  describe('POST /api/v1/groups', () => {
    it('should create and return 201', async () => {
      const res = await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'new-group', title: 'New Group' }),
      })
      expect(res.status).toBe(201)

      const body = await res.json()
      expect(body.name).toBe('new-group')
      expect(body.state).toBe('active')
    })

    it('should reject duplicate name', async () => {
      await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'dup-group' }),
      })

      const res = await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'dup-group' }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/v1/groups/:nameOrId', () => {
    it('should return by name', async () => {
      await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'get-group' }),
      })

      const res = await app.request('/api/v1/groups/get-group')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.name).toBe('get-group')
    })

    it('should return 404 for non-existent', async () => {
      const res = await app.request('/api/v1/groups/no-such')
      expect(res.status).toBe(404)
    })
  })

  describe('PUT /api/v1/groups/:nameOrId', () => {
    it('should update group', async () => {
      await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'update-group', title: 'Original' }),
      })

      const res = await app.request('/api/v1/groups/update-group', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated' }),
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.title).toBe('Updated')
    })
  })

  describe('DELETE /api/v1/groups/:nameOrId', () => {
    it('should soft delete', async () => {
      await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'delete-group' }),
      })

      const res = await app.request('/api/v1/groups/delete-group', { method: 'DELETE' })
      expect(res.status).toBe(200)

      const listRes = await app.request('/api/v1/groups')
      const body = await listRes.json()
      expect(body.total).toBe(0)
    })
  })

  describe('Authorization', () => {
    it('should reject unauthenticated create', async () => {
      const noAuthApp = createTestApp(db, { user: null })
      const res = await noAuthApp.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'no-auth-group' }),
      })
      expect(res.status).toBe(403)
    })

    it('should reject non-sysadmin create', async () => {
      const regularApp = createTestApp(db, {
        user: {
          id: '00000000-0000-0000-0000-000000000099',
          email: 'regular@example.com',
          name: 'regular',
          sysadmin: false,
        },
      })
      const res = await regularApp.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'regular-group' }),
      })
      expect(res.status).toBe(403)
    })

    it('should reject unauthenticated update', async () => {
      await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'auth-update-group' }),
      })

      const noAuthApp = createTestApp(db, { user: null })
      const res = await noAuthApp.request('/api/v1/groups/auth-update-group', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Hacked' }),
      })
      expect(res.status).toBe(403)
    })

    it('should reject unauthenticated delete', async () => {
      await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'auth-delete-group' }),
      })

      const noAuthApp = createTestApp(db, { user: null })
      const res = await noAuthApp.request('/api/v1/groups/auth-delete-group', {
        method: 'DELETE',
      })
      expect(res.status).toBe(403)
    })

    it('should reject non-member update', async () => {
      await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'no-member-update-group' }),
      })

      const regularApp = createTestApp(db, {
        user: {
          id: '00000000-0000-0000-0000-000000000099',
          email: 'regular@example.com',
          name: 'regular',
          sysadmin: false,
        },
      })
      const res = await regularApp.request('/api/v1/groups/no-member-update-group', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Hacked' }),
      })
      expect(res.status).toBe(403)
    })

    it('should reject non-member delete', async () => {
      await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'no-member-delete-group' }),
      })

      const regularApp = createTestApp(db, {
        user: {
          id: '00000000-0000-0000-0000-000000000099',
          email: 'regular@example.com',
          name: 'regular',
          sysadmin: false,
        },
      })
      const res = await regularApp.request('/api/v1/groups/no-member-delete-group', {
        method: 'DELETE',
      })
      expect(res.status).toBe(403)
    })
  })
})
