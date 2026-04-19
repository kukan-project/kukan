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
      expect(body).toEqual({ total: 1, active: 1, sysadmin: 1, deleted: 0 })
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
      expect(body.deleted).toBe(1) // user-c
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

  // ---- PATCH /api/v1/admin/users/:userId ----
  describe('PATCH /api/v1/admin/users/:userId', () => {
    const targetId = '00000000-0000-0000-0000-000000000010'

    beforeEach(async () => {
      await insertUser(targetId, 'target-user', 'target@example.com', 'user')
    })

    it('should reject unauthenticated requests', async () => {
      const res = await unauthApp.request(`/api/v1/admin/users/${targetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'New Name' }),
      })
      expect(res.status).toBe(403)
    })

    it('should reject non-sysadmin requests', async () => {
      const res = await nonAdminApp.request(`/api/v1/admin/users/${targetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'New Name' }),
      })
      expect(res.status).toBe(403)
    })

    it('should update name', async () => {
      const res = await app.request(`/api/v1/admin/users/${targetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'renamed-user' }),
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.name).toBe('renamed-user')
    })

    it('should reject duplicate name', async () => {
      await insertUser('00000000-0000-0000-0000-000000000011', 'existing-user', 'ex@example.com')

      const res = await app.request(`/api/v1/admin/users/${targetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'existing-user' }),
      })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.detail).toContain('already taken')
    })

    it('should allow keeping the same name', async () => {
      const res = await app.request(`/api/v1/admin/users/${targetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'target-user' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.name).toBe('target-user')
    })

    it('should update displayName', async () => {
      const res = await app.request(`/api/v1/admin/users/${targetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Updated Display' }),
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.displayName).toBe('Updated Display')
      expect(body.role).toBe('user')
    })

    it('should update role', async () => {
      const res = await app.request(`/api/v1/admin/users/${targetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'sysadmin' }),
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.role).toBe('sysadmin')
    })

    it('should reject self-demotion', async () => {
      const res = await app.request(`/api/v1/admin/users/${TEST_USER_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'user' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.detail).toContain('demote')
    })

    it('should reject invalid name format', async () => {
      const res = await app.request(`/api/v1/admin/users/${targetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'UPPER CASE!' }),
      })
      expect(res.status).toBe(400)
    })

    it('should return 400 for empty update', async () => {
      const res = await app.request(`/api/v1/admin/users/${targetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })

    it('should return 404 for non-existent user', async () => {
      const res = await app.request('/api/v1/admin/users/00000000-0000-0000-0000-999999999999', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'test' }),
      })
      expect(res.status).toBe(404)
    })
  })

  // ---- DELETE /api/v1/admin/users/:userId ----
  describe('DELETE /api/v1/admin/users/:userId', () => {
    const targetId = '00000000-0000-0000-0000-000000000010'

    beforeEach(async () => {
      await insertUser(targetId, 'target-user', 'target@example.com', 'user')
    })

    it('should reject unauthenticated requests', async () => {
      const res = await unauthApp.request(`/api/v1/admin/users/${targetId}`, {
        method: 'DELETE',
      })
      expect(res.status).toBe(403)
    })

    it('should reject non-sysadmin requests', async () => {
      const res = await nonAdminApp.request(`/api/v1/admin/users/${targetId}`, {
        method: 'DELETE',
      })
      expect(res.status).toBe(403)
    })

    it('should soft-delete user (set state to deleted)', async () => {
      const res = await app.request(`/api/v1/admin/users/${targetId}`, {
        method: 'DELETE',
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.success).toBe(true)

      // Verify state changed
      const result = await db.execute(sql`SELECT state FROM "user" WHERE id = ${targetId}`)
      expect((result.rows[0] as Record<string, unknown>).state).toBe('deleted')
    })

    it('should reject self-deletion', async () => {
      const res = await app.request(`/api/v1/admin/users/${TEST_USER_ID}`, {
        method: 'DELETE',
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.detail).toContain('yourself')
    })

    it('should return 404 for non-existent user', async () => {
      const res = await app.request('/api/v1/admin/users/00000000-0000-0000-0000-999999999999', {
        method: 'DELETE',
      })
      expect(res.status).toBe(404)
    })

    it('should revoke all sessions and API tokens on delete', async () => {
      // Insert a session for target user
      await db.execute(sql`
        INSERT INTO "session" (id, "userId", "expiresAt", token)
        VALUES ('sess-1', ${targetId}, NOW() + INTERVAL '1 day', 'session-token-1')
      `)
      // Insert an API token for target user
      await db.execute(sql`
        INSERT INTO "api_token" (user_id, token_hash, name)
        VALUES (${targetId}, 'hash-1', 'test-token')
      `)

      // Verify they exist before delete
      const sessionsBefore = await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM "session" WHERE "userId" = ${targetId}`
      )
      expect((sessionsBefore.rows[0] as Record<string, unknown>).count).toBe(1)
      const tokensBefore = await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM "api_token" WHERE user_id = ${targetId}`
      )
      expect((tokensBefore.rows[0] as Record<string, unknown>).count).toBe(1)

      // Delete the user
      const res = await app.request(`/api/v1/admin/users/${targetId}`, { method: 'DELETE' })
      expect(res.status).toBe(200)

      // Verify sessions and tokens are gone
      const sessionsAfter = await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM "session" WHERE "userId" = ${targetId}`
      )
      expect((sessionsAfter.rows[0] as Record<string, unknown>).count).toBe(0)
      const tokensAfter = await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM "api_token" WHERE user_id = ${targetId}`
      )
      expect((tokensAfter.rows[0] as Record<string, unknown>).count).toBe(0)
    })
  })
})
