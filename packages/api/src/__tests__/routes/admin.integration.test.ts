import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestApp } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'
import type { SearchAdapter } from '@kukan/search-adapter'

const db = getTestDb()

const mockSearch: SearchAdapter = {
  indexPackage: async () => {},
  deletePackage: async () => {},
  bulkIndexPackages: vi.fn().mockResolvedValue(undefined),
  deleteAllPackages: vi.fn().mockResolvedValue(undefined),
  indexResource: async () => {},
  deleteResource: async () => {},
  bulkIndexResources: async () => {},
  deleteAllResources: async () => {},
  search: async () => ({ items: [], total: 0, offset: 0, limit: 20 }),
  sumResourceCount: async () => 0,
  getIndexStats: async () => ({
    packages: { docCount: 0, sizeBytes: 0, recentDocs: [] },
    resources: { docCount: 0, sizeBytes: 0, recentDocs: [] },
    contents: { docCount: 0, sizeBytes: 0, recentDocs: [] },
  }),
  indexContent: async () => {},
  deleteContent: async () => {},
  deleteAllContents: async () => {},
  getDocument: async () => null,
  browseDocuments: async () => null,
  getContentChunks: async () => [],
  browseContentsByResource: async () => ({ items: [], total: 0, offset: 0, limit: 20 }),
  fetchContentHighlights: async () => ({}),
}

const app = createTestApp(db, { search: mockSearch })
const unauthApp = createTestApp(db, { user: null, search: mockSearch })
const nonAdminApp = createTestApp(db, {
  user: {
    id: '00000000-0000-0000-0000-000000000002',
    email: 'regular@example.com',
    name: 'regular-user',
    sysadmin: false,
  },
  search: mockSearch,
})

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
})

afterAll(async () => {
  await closeTestDb()
})

/** Create org and return its ID */
async function ensureOrg(name: string): Promise<string> {
  const res = await app.request('/api/v1/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, title: name }),
  })
  const org = await res.json()
  return org.id
}

describe('Admin API Routes', () => {
  describe('POST /api/v1/admin/reindex-metadata', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await unauthApp.request('/api/v1/admin/reindex-metadata', { method: 'POST' })
      expect(res.status).toBe(403)
    })

    it('should reject non-sysadmin requests', async () => {
      const res = await nonAdminApp.request('/api/v1/admin/reindex-metadata', { method: 'POST' })
      expect(res.status).toBe(403)
    })

    it('should enqueue reindex job via SQS', async () => {
      const res = await app.request('/api/v1/admin/reindex-metadata', { method: 'POST' })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.queued).toBe(true)
    })

    it('should return 400 when OpenSearch is not enabled', async () => {
      const pgSearch: SearchAdapter = { ...mockSearch, getIndexStats: async () => null }
      const pgApp = createTestApp(db, { search: pgSearch })

      const res = await pgApp.request('/api/v1/admin/reindex-metadata', { method: 'POST' })
      expect(res.status).toBe(400)

      const body = await res.json()
      expect(body.detail).toBe('OpenSearch not enabled')
    })
  })

  describe('GET /api/v1/admin/search/stats', () => {
    it('should return index stats with DB counts', async () => {
      const res = await app.request('/api/v1/admin/search/stats')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.enabled).toBe(true)
      expect(body.db).toBeDefined()
      expect(typeof body.db.packages).toBe('number')
      expect(typeof body.db.resources).toBe('number')
    })

    it('should reject non-sysadmin requests', async () => {
      const res = await nonAdminApp.request('/api/v1/admin/search/stats')
      expect(res.status).toBe(403)
    })
  })

  describe('POST /api/v1/admin/users/:userId/restore', () => {
    /** Create a test user with a unique name to avoid constraint conflicts across runs */
    function uniqueName(prefix: string) {
      return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    }

    it('should reject unauthenticated requests', async () => {
      const res = await unauthApp.request('/api/v1/admin/users/fake-id/restore', { method: 'POST' })
      expect(res.status).toBe(403)
    })

    it('should reject non-sysadmin requests', async () => {
      const res = await nonAdminApp.request('/api/v1/admin/users/fake-id/restore', {
        method: 'POST',
      })
      expect(res.status).toBe(403)
    })

    it('should prevent self-restore', async () => {
      const res = await app.request(
        '/api/v1/admin/users/00000000-0000-0000-0000-000000000001/restore',
        { method: 'POST' }
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.detail).toContain('yourself')
    })

    it('should return 404 for non-existent user', async () => {
      const res = await app.request('/api/v1/admin/users/non-existent-id/restore', {
        method: 'POST',
      })
      expect(res.status).toBe(404)
    })

    it('should reject restore of active user', async () => {
      const name = uniqueName('active-restore')
      const result = await db.execute(
        sql`INSERT INTO "user" (id, name, email, "emailVerified", state, role, "createdAt", "updatedAt")
            VALUES (gen_random_uuid(), ${name}, ${name + '@example.com'}, false, 'active', 'user', NOW(), NOW())
            RETURNING id`
      )
      const userId = (result.rows[0] as { id: string }).id

      const res = await app.request(`/api/v1/admin/users/${userId}/restore`, { method: 'POST' })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.detail).toContain('soft-deleted')
    })

    it('should restore a soft-deleted user', async () => {
      const name = uniqueName('to-restore')
      const result = await db.execute(
        sql`INSERT INTO "user" (id, name, email, "emailVerified", state, role, "createdAt", "updatedAt")
            VALUES (gen_random_uuid(), ${name}, ${name + '@example.com'}, false, 'deleted', 'user', NOW(), NOW())
            RETURNING id`
      )
      const userId = (result.rows[0] as { id: string }).id

      const res = await app.request(`/api/v1/admin/users/${userId}/restore`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)

      const check = await db.execute(sql`SELECT state FROM "user" WHERE id = ${userId}`)
      expect((check.rows[0] as { state: string }).state).toBe('active')
    })
  })

  describe('POST /api/v1/admin/users/:userId/purge', () => {
    function uniqueName(prefix: string) {
      return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    }

    async function createAndDeleteUser(prefix: string) {
      const name = uniqueName(prefix)
      const result = await db.execute(
        sql`INSERT INTO "user" (id, name, email, "emailVerified", state, role, "createdAt", "updatedAt")
            VALUES (gen_random_uuid(), ${name}, ${name + '@example.com'}, false, 'deleted', 'user', NOW(), NOW())
            RETURNING id`
      )
      return (result.rows[0] as { id: string }).id
    }

    it('should reject unauthenticated requests', async () => {
      const res = await unauthApp.request('/api/v1/admin/users/fake-id/purge', { method: 'POST' })
      expect(res.status).toBe(403)
    })

    it('should reject non-sysadmin requests', async () => {
      const res = await nonAdminApp.request('/api/v1/admin/users/fake-id/purge', { method: 'POST' })
      expect(res.status).toBe(403)
    })

    it('should return 404 for non-existent user', async () => {
      const res = await app.request('/api/v1/admin/users/non-existent-id/purge', { method: 'POST' })
      expect(res.status).toBe(404)
    })

    it('should reject purge of active (non-deleted) user', async () => {
      const name = uniqueName('active-user')
      const result = await db.execute(
        sql`INSERT INTO "user" (id, name, email, "emailVerified", state, role, "createdAt", "updatedAt")
            VALUES (gen_random_uuid(), ${name}, ${name + '@example.com'}, false, 'active', 'user', NOW(), NOW())
            RETURNING id`
      )
      const userId = (result.rows[0] as { id: string }).id

      const res = await app.request(`/api/v1/admin/users/${userId}/purge`, { method: 'POST' })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.detail).toContain('soft-deleted')
    })

    it('should reject purge when user has linked packages', async () => {
      const orgId = await ensureOrg('purge-test-org')
      const userId = await createAndDeleteUser('pkg-linked')

      const pkgName = uniqueName('purge-test-pkg')
      await db.execute(
        sql`INSERT INTO package (name, state, creator_user_id, owner_org) VALUES (${pkgName}, 'active', ${userId}, ${orgId})`
      )

      const res = await app.request(`/api/v1/admin/users/${userId}/purge`, { method: 'POST' })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.detail).toContain('linked packages')
    })

    it('should prevent self-purge', async () => {
      const res = await app.request(
        '/api/v1/admin/users/00000000-0000-0000-0000-000000000001/purge',
        { method: 'POST' }
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.detail).toContain('yourself')
    })

    it('should purge a soft-deleted user and nullify activity/audit references', async () => {
      const userId = await createAndDeleteUser('to-purge')

      // Insert activity and audit log for this user
      await db.execute(
        sql`INSERT INTO activity (object_id, object_type, activity_type, user_id) VALUES (gen_random_uuid(), 'test', 'test_action', ${userId})`
      )
      await db.execute(
        sql`INSERT INTO audit_log (entity_type, entity_id, action, user_id) VALUES ('test', ${userId}, 'test_action', ${userId})`
      )

      const res = await app.request(`/api/v1/admin/users/${userId}/purge`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)

      // Verify user is gone
      const userCheck = await db.execute(sql`SELECT id FROM "user" WHERE id = ${userId}`)
      expect(userCheck.rows).toHaveLength(0)

      // Verify activity/audit_log user_id is nullified
      const activityCheck = await db.execute(
        sql`SELECT user_id FROM activity WHERE object_type = 'test'`
      )
      for (const row of activityCheck.rows) {
        expect((row as { user_id: string | null }).user_id).toBeNull()
      }

      // Verify purge audit log was recorded with purgedUserId in changes
      const auditCheck = await db.execute(
        sql`SELECT changes FROM audit_log WHERE action = 'purge' AND entity_type = 'user'`
      )
      expect(auditCheck.rows).toHaveLength(1)
      const changes = (auditCheck.rows[0] as { changes: Record<string, unknown> }).changes
      expect(changes.purgedUserId).toBe(userId)
    })
  })
})
