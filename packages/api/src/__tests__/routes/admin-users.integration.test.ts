import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestApp } from '../test-helpers/test-app'
import {
  getTestDb,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  TEST_USER_ID,
} from '../test-helpers/test-db'
import type { Auth } from '../../auth/auth'

const db = getTestDb()

const mockCreateUser = vi.fn().mockResolvedValue({
  id: 'new-user-id',
  name: 'new-user',
  email: 'new@example.com',
})
const mockAuth = {
  api: { createUser: mockCreateUser },
} as unknown as Auth

const app = createTestApp(db, { auth: mockAuth })
const unauthApp = createTestApp(db, { user: null, auth: mockAuth })
const nonAdminApp = createTestApp(db, {
  user: {
    id: '00000000-0000-0000-0000-000000000002',
    email: 'regular@example.com',
    name: 'regular-user',
    sysadmin: false,
  },
  auth: mockAuth,
})

/** Insert a test user directly into the database */
async function insertUser(
  id: string,
  name: string,
  email: string,
  role = 'user',
  state = 'active'
) {
  await db.execute(sql`
    INSERT INTO "user" (id, email, name, "emailVerified", role, state)
    VALUES (${id}, ${email}, ${name}, true, ${role}, ${state})
    ON CONFLICT (id) DO NOTHING
  `)
}

beforeEach(async () => {
  await cleanDatabase()
  // Clean non-default users (keep test-admin for FK constraints)
  await db.execute(sql`DELETE FROM "user" WHERE id != ${TEST_USER_ID}`)
  await ensureTestUser()
  mockCreateUser.mockClear()
})

afterAll(async () => {
  await closeTestDb()
})

describe('Admin Users API', () => {
  // ---- GET /api/v1/admin/users/stats ----
  describe('GET /api/v1/admin/users/stats', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await unauthApp.request('/api/v1/admin/users/stats')
      expect(res.status).toBe(403)
    })

    it('should reject non-sysadmin requests', async () => {
      const res = await nonAdminApp.request('/api/v1/admin/users/stats')
      expect(res.status).toBe(403)
    })

    it('should return stats with only the test admin', async () => {
      const res = await app.request('/api/v1/admin/users/stats')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toEqual({ total: 1, active: 1, sysadmin: 1 })
    })

    it('should count users by state and role', async () => {
      await insertUser(
        '00000000-0000-0000-0000-000000000010',
        'user-a',
        'a@example.com',
        'user',
        'active'
      )
      await insertUser(
        '00000000-0000-0000-0000-000000000011',
        'user-b',
        'b@example.com',
        'user',
        'active'
      )
      await insertUser(
        '00000000-0000-0000-0000-000000000012',
        'user-c',
        'c@example.com',
        'user',
        'deleted'
      )

      const res = await app.request('/api/v1/admin/users/stats')
      const body = await res.json()

      expect(body.total).toBe(4) // test-admin + 3
      expect(body.active).toBe(3) // test-admin + user-a + user-b
      expect(body.sysadmin).toBe(1) // test-admin only
    })
  })

  // ---- GET /api/v1/admin/users ----
  describe('GET /api/v1/admin/users', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await unauthApp.request('/api/v1/admin/users')
      expect(res.status).toBe(403)
    })

    it('should reject non-sysadmin requests', async () => {
      const res = await nonAdminApp.request('/api/v1/admin/users')
      expect(res.status).toBe(403)
    })

    it('should return paginated user list', async () => {
      await insertUser('00000000-0000-0000-0000-000000000010', 'alice', 'alice@example.com')
      await insertUser('00000000-0000-0000-0000-000000000011', 'bob', 'bob@example.com')

      const res = await app.request('/api/v1/admin/users')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.total).toBe(3)
      expect(body.items).toHaveLength(3)
      expect(body.items[0]).toHaveProperty('id')
      expect(body.items[0]).toHaveProperty('name')
      expect(body.items[0]).toHaveProperty('email')
      expect(body.items[0]).toHaveProperty('role')
      expect(body.items[0]).toHaveProperty('state')
      expect(body.items[0]).toHaveProperty('createdAt')
    })

    it('should search by name', async () => {
      await insertUser('00000000-0000-0000-0000-000000000010', 'alice', 'alice@example.com')
      await insertUser('00000000-0000-0000-0000-000000000011', 'bob', 'bob@example.com')

      const res = await app.request('/api/v1/admin/users?q=alice')
      const body = await res.json()

      expect(body.total).toBe(1)
      expect(body.items[0].name).toBe('alice')
    })

    it('should search by email', async () => {
      await insertUser('00000000-0000-0000-0000-000000000010', 'alice', 'alice@special.com')

      const res = await app.request('/api/v1/admin/users?q=special')
      const body = await res.json()

      expect(body.total).toBe(1)
      expect(body.items[0].email).toBe('alice@special.com')
    })

    it('should support pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await insertUser(
          `00000000-0000-0000-0000-0000000000${10 + i}`,
          `user-${i}`,
          `user${i}@example.com`
        )
      }

      const res = await app.request('/api/v1/admin/users?limit=2&offset=0')
      const body = await res.json()

      expect(body.total).toBe(6) // 5 + test-admin
      expect(body.items).toHaveLength(2)
    })
  })

  // ---- POST /api/v1/admin/users ----
  describe('POST /api/v1/admin/users', () => {
    const validBody = {
      name: 'new-user',
      email: 'new@example.com',
      password: 'password123',
      role: 'user',
    }

    it('should reject unauthenticated requests', async () => {
      const res = await unauthApp.request('/api/v1/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      })
      expect(res.status).toBe(403)
    })

    it('should reject non-sysadmin requests', async () => {
      const res = await nonAdminApp.request('/api/v1/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      })
      expect(res.status).toBe(403)
    })

    it('should create a user via auth.api.createUser', async () => {
      const res = await app.request('/api/v1/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      })
      expect(res.status).toBe(201)

      expect(mockCreateUser).toHaveBeenCalledOnce()
      expect(mockCreateUser).toHaveBeenCalledWith({
        body: {
          name: 'new-user',
          email: 'new@example.com',
          password: 'password123',
        },
      })
    })

    it('should pass sysadmin role when specified', async () => {
      await app.request('/api/v1/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, role: 'sysadmin' }),
      })

      expect(mockCreateUser).toHaveBeenCalledWith({
        body: {
          name: 'new-user',
          email: 'new@example.com',
          password: 'password123',
          role: 'sysadmin',
        },
      })
    })

    it('should reject invalid name format', async () => {
      const res = await app.request('/api/v1/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, name: 'UPPER CASE' }),
      })
      expect(res.status).toBe(400)
    })

    it('should reject missing required fields', async () => {
      const res = await app.request('/api/v1/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test' }),
      })
      expect(res.status).toBe(400)
    })

    it('should return 400 when auth.api.createUser fails', async () => {
      mockCreateUser.mockResolvedValueOnce(null)

      const res = await app.request('/api/v1/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      })
      expect(res.status).toBe(400)
    })
  })
})
