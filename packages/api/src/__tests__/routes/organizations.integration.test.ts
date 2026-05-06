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

  describe('Authorization', () => {
    it('should reject unauthenticated create', async () => {
      const noAuthApp = createTestApp(db, { user: null })
      const res = await noAuthApp.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'no-auth-org' }),
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
      const res = await regularApp.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'regular-org' }),
      })
      expect(res.status).toBe(403)
    })

    it('should reject unauthenticated update', async () => {
      // Create as sysadmin first
      await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'auth-update-org' }),
      })

      const noAuthApp = createTestApp(db, { user: null })
      const res = await noAuthApp.request('/api/v1/organizations/auth-update-org', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Hacked' }),
      })
      expect(res.status).toBe(403)
    })

    it('should reject unauthenticated delete', async () => {
      await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'auth-delete-org' }),
      })

      const noAuthApp = createTestApp(db, { user: null })
      const res = await noAuthApp.request('/api/v1/organizations/auth-delete-org', {
        method: 'DELETE',
      })
      expect(res.status).toBe(403)
    })

    it('should reject non-member update', async () => {
      await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'no-member-update-org' }),
      })

      const regularApp = createTestApp(db, {
        user: {
          id: '00000000-0000-0000-0000-000000000099',
          email: 'regular@example.com',
          name: 'regular',
          sysadmin: false,
        },
      })
      const res = await regularApp.request('/api/v1/organizations/no-member-update-org', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Hacked' }),
      })
      expect(res.status).toBe(403)
    })

    it('should reject non-member delete', async () => {
      await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'no-member-delete-org' }),
      })

      const regularApp = createTestApp(db, {
        user: {
          id: '00000000-0000-0000-0000-000000000099',
          email: 'regular@example.com',
          name: 'regular',
          sysadmin: false,
        },
      })
      const res = await regularApp.request('/api/v1/organizations/no-member-delete-org', {
        method: 'DELETE',
      })
      expect(res.status).toBe(403)
    })
  })

  describe('POST /api/v1/organizations/:nameOrId/purge', () => {
    it('should reject non-sysadmin requests', async () => {
      const regularApp = createTestApp(db, {
        user: { id: 'regular', email: 'r@r.com', name: 'regular', sysadmin: false },
      })
      const res = await regularApp.request('/api/v1/organizations/any/purge', { method: 'POST' })
      expect(res.status).toBe(403)
    })

    it('should return 404 for active organization', async () => {
      await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'active-purge-org', title: 'Active' }),
      })
      const res = await app.request('/api/v1/organizations/active-purge-org/purge', {
        method: 'POST',
      })
      expect(res.status).toBe(404)
    })

    it('should reject purge when organization has packages', async () => {
      // Create org and soft-delete
      const orgRes = await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'pkg-purge-org', title: 'Has Packages' }),
      })
      const org = await orgRes.json()

      // Create package in this org
      await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'org-linked-pkg', title: 'Linked', owner_org: org.id }),
      })

      // Soft-delete org
      await app.request('/api/v1/organizations/pkg-purge-org', { method: 'DELETE' })

      const res = await app.request('/api/v1/organizations/pkg-purge-org/purge', { method: 'POST' })
      expect(res.status).toBe(409)
    })

    it('should purge a soft-deleted organization', async () => {
      await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'purge-org', title: 'To Purge' }),
      })
      await app.request('/api/v1/organizations/purge-org', { method: 'DELETE' })

      const res = await app.request('/api/v1/organizations/purge-org/purge', { method: 'POST' })
      expect(res.status).toBe(200)

      // Verify it's gone
      const getRes = await app.request('/api/v1/organizations/purge-org')
      expect(getRes.status).toBe(404)
    })
  })

  describe('POST /api/v1/organizations/:nameOrId/restore', () => {
    it('should reject non-sysadmin requests', async () => {
      const regularApp = createTestApp(db, {
        user: { id: 'regular', email: 'r@r.com', name: 'regular', sysadmin: false },
      })
      const res = await regularApp.request('/api/v1/organizations/any/restore', { method: 'POST' })
      expect(res.status).toBe(403)
    })

    it('should restore a soft-deleted organization', async () => {
      await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'restore-org', title: 'To Restore' }),
      })
      await app.request('/api/v1/organizations/restore-org', { method: 'DELETE' })

      const res = await app.request('/api/v1/organizations/restore-org/restore', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.state).toBe('active')

      // Verify it's visible again
      const getRes = await app.request('/api/v1/organizations/restore-org')
      expect(getRes.status).toBe(200)
    })
  })
})
