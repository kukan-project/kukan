import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createTestApp } from '../test-helpers/test-app'
import {
  getTestDb,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  ensureOutsiderUser,
  OUTSIDER_USER_ID,
} from '../test-helpers/test-db'

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

    // The roster behind GET /:nameOrId/members is member-only, so the count
    // that summarises it must not reach a caller who cannot open it.
    describe('member counts', () => {
      const outsiderApp = createTestApp(db, {
        user: {
          id: OUTSIDER_USER_ID,
          email: 'outsider@example.com',
          name: 'outsider',
          sysadmin: false,
        },
      })

      beforeEach(async () => {
        await ensureOutsiderUser()
        for (const name of ['group-joined', 'group-other']) {
          await app.request('/api/v1/groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          })
        }
        await app.request('/api/v1/groups/group-joined/members', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: OUTSIDER_USER_ID, role: 'member' }),
        })
      })

      async function listAs(client: typeof app) {
        const body = await (await client.request('/api/v1/groups')).json()
        return Object.fromEntries(
          body.items.map((g: { name: string; memberCount: number | null }) => [
            g.name,
            g.memberCount,
          ])
        )
      }

      it('should omit counts for anonymous callers', async () => {
        expect(await listAs(createTestApp(db, { user: null }))).toEqual({
          'group-joined': null,
          'group-other': null,
        })
      })

      it('should count only the categories the viewer belongs to', async () => {
        expect(await listAs(outsiderApp)).toEqual({ 'group-joined': 1, 'group-other': null })
      })

      it('should count every category for a sysadmin', async () => {
        expect(await listAs(app)).toEqual({ 'group-joined': 1, 'group-other': 0 })
      })
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

    it('should return group by UUID-shaped name (CKAN uuid slugs)', async () => {
      const uuidName = 'aaaaaaaa-4444-5555-6666-eeeeeeeeeeee'
      await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: uuidName, title: 'UUID Group' }),
      })

      const res = await app.request(`/api/v1/groups/${uuidName}`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.name).toBe(uuidName)
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
        body: JSON.stringify({ name: 'update-group', title: 'Updated' }),
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
      expect(res.status).toBe(401)
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
        body: JSON.stringify({ name: 'auth-update-group', title: 'Hacked' }),
      })
      expect(res.status).toBe(401)
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
      expect(res.status).toBe(401)
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
        body: JSON.stringify({ name: 'no-member-update-group', title: 'Hacked' }),
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

  describe('POST /api/v1/groups/:nameOrId/purge', () => {
    it('should reject non-sysadmin requests', async () => {
      const regularApp = createTestApp(db, {
        user: { id: 'regular', email: 'r@r.com', name: 'regular', sysadmin: false },
      })
      const res = await regularApp.request('/api/v1/groups/any/purge', { method: 'POST' })
      expect(res.status).toBe(403)
    })

    it('should return 404 for active group', async () => {
      await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'active-purge-group', title: 'Active' }),
      })
      const res = await app.request('/api/v1/groups/active-purge-group/purge', { method: 'POST' })
      expect(res.status).toBe(404)
    })

    it('should purge a soft-deleted group', async () => {
      await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'purge-group', title: 'To Purge' }),
      })
      await app.request('/api/v1/groups/purge-group', { method: 'DELETE' })

      const res = await app.request('/api/v1/groups/purge-group/purge', { method: 'POST' })
      expect(res.status).toBe(200)

      const getRes = await app.request('/api/v1/groups/purge-group')
      expect(getRes.status).toBe(404)
    })
  })

  describe('POST /api/v1/groups/:nameOrId/restore', () => {
    it('should reject non-sysadmin requests', async () => {
      const regularApp = createTestApp(db, {
        user: { id: 'regular', email: 'r@r.com', name: 'regular', sysadmin: false },
      })
      const res = await regularApp.request('/api/v1/groups/any/restore', { method: 'POST' })
      expect(res.status).toBe(403)
    })

    it('should restore a soft-deleted group', async () => {
      await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'restore-group', title: 'To Restore' }),
      })
      await app.request('/api/v1/groups/restore-group', { method: 'DELETE' })

      const res = await app.request('/api/v1/groups/restore-group/restore', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.state).toBe('active')

      const getRes = await app.request('/api/v1/groups/restore-group')
      expect(getRes.status).toBe(200)
    })
  })

  describe('list ordering', () => {
    /** 'aaa-group' sorts first by name but has no datasets; 'zzz-group' has one */
    async function seedUnevenGroups() {
      const json = (data: Record<string, unknown>) => ({
        method: 'POST' as const,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      await app.request('/api/v1/groups', json({ name: 'aaa-group', title: 'A' }))
      await app.request('/api/v1/groups', json({ name: 'zzz-group', title: 'Z' }))
      const orgRes = await app.request('/api/v1/organizations', json({ name: 'order-org' }))
      const org = await orgRes.json()
      await app.request(
        '/api/v1/packages',
        json({ name: 'order-pkg', ownerOrg: org.id, groups: [{ name: 'zzz-group' }] })
      )
    }

    it('orders by dataset count before applying the limit', async () => {
      await seedUnevenGroups()

      const { GroupService } = await import('../../services/group-service')
      const { items } = await new GroupService(db).list({ limit: 1, orderBy: 'datasetCount' })

      // Usage wins over name: the capped fetch keeps the most-used group
      expect(items).toHaveLength(1)
      expect(items[0].name).toBe('zzz-group')
      expect(items[0].datasetCount).toBe(1)
    })

    // The ordering existed; orderBy makes it reachable over HTTP rather than
    // being an option only the suggest flow could pass (#261)
    it('accepts orderBy from the query string', async () => {
      await seedUnevenGroups()

      const res = await app.request('/api/v1/groups?orderBy=datasetCount&limit=1')
      expect(res.status).toBe(200)
      const { items } = await res.json()
      // The default order would have returned aaa-group here
      expect(items[0].name).toBe('zzz-group')
    })
  })
})
