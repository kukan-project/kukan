import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestApp } from '../test-helpers/test-app'
import {
  getTestDb,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  TEST_USER_ID,
} from '../test-helpers/test-db'

const db = getTestDb()
const app = createTestApp(db)
const unauthApp = createTestApp(db, { user: null })
const regularApp = createTestApp(db, {
  user: {
    id: TEST_USER_ID,
    email: 'test-admin@example.com',
    name: 'test-admin',
    sysadmin: false,
  },
})

async function insertOrg(id: string, name: string) {
  await db.execute(sql`
    INSERT INTO "organization" (id, name, title, state, created, updated)
    VALUES (${id}, ${name}, ${name}, 'active', NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `)
}

async function insertMembership(userId: string, orgId: string, role = 'admin') {
  await db.execute(sql`
    INSERT INTO "user_org_membership" (id, user_id, organization_id, role, created)
    VALUES (gen_random_uuid(), ${userId}, ${orgId}, ${role}, NOW())
    ON CONFLICT DO NOTHING
  `)
}

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
})

afterAll(async () => {
  await closeTestDb()
})

describe('Users API', () => {
  describe('GET /api/v1/users/me', () => {
    it('should return current user info', async () => {
      const res = await app.request('/api/v1/users/me')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.id).toBe(TEST_USER_ID)
      expect(body.name).toBe('test-admin')
      expect(body.email).toBe('test-admin@example.com')
      expect(body.sysadmin).toBe(true)
    })

    it('should return 401 for unauthenticated request', async () => {
      const res = await unauthApp.request('/api/v1/users/me')
      expect(res.status).toBe(401)
    })
  })

  describe('GET /api/v1/users/me/organizations', () => {
    it('should return all active orgs for sysadmin', async () => {
      await insertOrg('10000000-0000-0000-0000-000000000001', 'org-alpha')
      await insertOrg('10000000-0000-0000-0000-000000000002', 'org-beta')

      const res = await app.request('/api/v1/users/me/organizations')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.items).toHaveLength(2)
      expect(body.items.every((o: { role: string }) => o.role === 'admin')).toBe(true)
    })

    it('should return only member orgs for regular user', async () => {
      await insertOrg('10000000-0000-0000-0000-000000000001', 'org-alpha')
      await insertOrg('10000000-0000-0000-0000-000000000002', 'org-beta')
      await insertMembership(TEST_USER_ID, '10000000-0000-0000-0000-000000000001', 'editor')

      const res = await regularApp.request('/api/v1/users/me/organizations')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.items).toHaveLength(1)
      expect(body.items[0].name).toBe('org-alpha')
      expect(body.items[0].role).toBe('editor')
    })

    it('should return 401 for unauthenticated request', async () => {
      const res = await unauthApp.request('/api/v1/users/me/organizations')
      expect(res.status).toBe(401)
    })
  })

  describe('GET /api/v1/users', () => {
    it('should search users by name', async () => {
      const res = await app.request('/api/v1/users?q=test-admin')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.items.length).toBeGreaterThan(0)
      expect(body.items[0].name).toBe('test-admin')
    })

    it('should return empty for non-matching query', async () => {
      const res = await app.request('/api/v1/users?q=nonexistent-user-xyz')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.items).toHaveLength(0)
    })

    it('should return 401 for unauthenticated request', async () => {
      const res = await unauthApp.request('/api/v1/users?q=test')
      expect(res.status).toBe(401)
    })

    it('should require q parameter', async () => {
      const res = await app.request('/api/v1/users')
      expect(res.status).toBe(400)
    })
  })
})
