/**
 * Privileged changes leave one audit row, written with the change: a refused
 * change leaves none.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { asc, sql } from 'drizzle-orm'
import { auditLog } from '@kukan/db'
import { createTestApp, defaultTestUser } from '../test-helpers/test-app'
import {
  getTestDb,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  ensureOutsiderUser,
  OUTSIDER_USER_ID,
  TEST_USER_ID,
} from '../test-helpers/test-db'
import type { Auth } from '../../auth/auth'

const db = getTestDb()

const mockCreateUser = vi.fn()
const mockAuth = { api: { createUser: mockCreateUser } } as unknown as Auth

const app = createTestApp(db, { auth: mockAuth })
const tokenApp = createTestApp(db, {
  user: { ...defaultTestUser, authMethod: 'token' },
  auth: mockAuth,
})

const MISSING_UUID = '00000000-0000-4000-8000-000000000999'

async function auditRows() {
  return db
    .select({
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      action: auditLog.action,
      userId: auditLog.userId,
      changes: auditLog.changes,
    })
    .from(auditLog)
    .orderBy(asc(auditLog.id))
}

function send(target: typeof app, method: string, path: string, body?: unknown) {
  return target.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

beforeEach(async () => {
  await cleanDatabase()
  await db.execute(sql`DELETE FROM "user" WHERE id NOT IN (${TEST_USER_ID}, ${OUTSIDER_USER_ID})`)
  await ensureTestUser()
  await ensureOutsiderUser()
  await db.execute(sql`UPDATE "user" SET role = 'user' WHERE id = ${OUTSIDER_USER_ID}`)
  mockCreateUser.mockReset()
})

afterAll(async () => {
  await closeTestDb()
})

describe('audit log', () => {
  describe('users', () => {
    const createBody = {
      name: 'new-admin',
      email: 'new-admin@example.com',
      password: 'harbor-lantern-quiet-42',
      role: 'sysadmin',
    }

    it('records a user the admin API created, with its role', async () => {
      mockCreateUser.mockResolvedValue({
        user: {
          id: 'created-user-id',
          name: 'new-admin',
          email: 'x@example.com',
          role: 'sysadmin',
        },
      })
      expect((await send(app, 'POST', '/api/v1/admin/users', createBody)).status).toBe(201)

      expect(await auditRows()).toMatchObject([
        {
          entityType: 'user',
          action: 'create',
          userId: TEST_USER_ID,
          changes: { userId: 'created-user-id', role: 'sysadmin', authMethod: 'session' },
        },
      ])
      const [row] = await auditRows()
      expect(JSON.stringify(row.changes)).not.toContain(createBody.password)
    })

    it('records nothing when the creation is refused', async () => {
      mockCreateUser.mockResolvedValue(null)
      expect((await send(app, 'POST', '/api/v1/admin/users', createBody)).status).toBe(400)
      expect(await auditRows()).toEqual([])
    })

    it('records a role change with the role before and after', async () => {
      const res = await send(app, 'PATCH', `/api/v1/admin/users/${OUTSIDER_USER_ID}`, {
        role: 'sysadmin',
      })
      expect(res.status).toBe(200)

      expect(await auditRows()).toMatchObject([
        {
          entityType: 'user',
          action: 'update',
          userId: TEST_USER_ID,
          changes: {
            userId: OUTSIDER_USER_ID,
            previousRole: 'user',
            role: 'sysadmin',
            authMethod: 'session',
          },
        },
      ])
    })

    it('says the change came through a token when it did', async () => {
      await send(tokenApp, 'PATCH', `/api/v1/admin/users/${OUTSIDER_USER_ID}`, { role: 'sysadmin' })
      expect(await auditRows()).toMatchObject([{ changes: { authMethod: 'token' } }])
    })

    it('records nothing for an update that leaves the role as it was', async () => {
      await send(app, 'PATCH', `/api/v1/admin/users/${OUTSIDER_USER_ID}`, {
        displayName: 'Someone',
        role: 'user',
      })
      expect(await auditRows()).toEqual([])
    })

    it('records nothing for a role change on a user that does not exist', async () => {
      const res = await send(app, 'PATCH', '/api/v1/admin/users/no-such-user', { role: 'sysadmin' })
      expect(res.status).toBe(404)
      expect(await auditRows()).toEqual([])
    })

    it('records a deletion and a restore', async () => {
      expect((await send(app, 'DELETE', `/api/v1/admin/users/${OUTSIDER_USER_ID}`)).status).toBe(
        200
      )
      expect(
        (await send(app, 'POST', `/api/v1/admin/users/${OUTSIDER_USER_ID}/restore`)).status
      ).toBe(200)

      expect(await auditRows()).toMatchObject([
        {
          entityType: 'user',
          action: 'delete',
          userId: TEST_USER_ID,
          changes: { userId: OUTSIDER_USER_ID, authMethod: 'session' },
        },
        {
          entityType: 'user',
          action: 'restore',
          userId: TEST_USER_ID,
          changes: { userId: OUTSIDER_USER_ID, authMethod: 'session' },
        },
      ])
    })

    it('records nothing for a deletion of a user that does not exist', async () => {
      expect((await send(app, 'DELETE', '/api/v1/admin/users/no-such-user')).status).toBe(404)
      expect(await auditRows()).toEqual([])
    })

    it('records nothing for a restore of a user that is not deleted', async () => {
      const res = await send(app, 'POST', `/api/v1/admin/users/${OUTSIDER_USER_ID}/restore`)
      expect(res.status).toBe(400)
      expect(await auditRows()).toEqual([])
    })
  })

  describe.each([
    ['organization', '/api/v1/organizations'],
    ['group', '/api/v1/groups'],
  ])('%s members', (entityType, base) => {
    let entityId: string
    const members = () => `${base}/audit-target/members`

    beforeEach(async () => {
      const res = await send(app, 'POST', base, { name: 'audit-target', title: 'Audit Target' })
      entityId = (await res.json()).id
    })

    const memberRows = async () => (await auditRows()).filter((r) => r.action.startsWith('member_'))

    it('records an addition, a role change and a removal', async () => {
      await send(app, 'POST', members(), { user_id: OUTSIDER_USER_ID, role: 'member' })
      await send(app, 'POST', members(), { user_id: OUTSIDER_USER_ID, role: 'editor' })
      // The same role again changes nothing, so says nothing
      await send(app, 'POST', members(), { user_id: OUTSIDER_USER_ID, role: 'editor' })
      const removed = await send(app, 'DELETE', `${members()}/${OUTSIDER_USER_ID}`)
      expect(removed.status).toBe(200)

      expect(await memberRows()).toMatchObject([
        {
          entityType,
          entityId,
          action: 'member_add',
          userId: TEST_USER_ID,
          changes: { userId: OUTSIDER_USER_ID, role: 'member', authMethod: 'session' },
        },
        {
          entityType,
          entityId,
          action: 'member_update',
          changes: { userId: OUTSIDER_USER_ID, previousRole: 'member', role: 'editor' },
        },
        {
          entityType,
          entityId,
          action: 'member_remove',
          changes: { userId: OUTSIDER_USER_ID, role: 'editor' },
        },
      ])
    })

    it('records nothing for an addition of a user that does not exist', async () => {
      const res = await send(app, 'POST', members(), { user_id: 'no-such-user', role: 'admin' })
      expect(res.status).toBe(404)
      expect(await memberRows()).toEqual([])
    })

    it('records nothing for a removal of someone who is not a member', async () => {
      const res = await send(app, 'DELETE', `${members()}/${OUTSIDER_USER_ID}`)
      expect(res.status).toBe(404)
      expect(await memberRows()).toEqual([])
    })
  })

  describe('API tokens', () => {
    it('records an issue and a revocation, never the token itself', async () => {
      const created = await send(app, 'POST', '/api/v1/api-tokens', {
        name: 'CI',
        expiresInDays: 7,
      })
      expect(created.status).toBe(201)
      const { id, token } = await created.json()
      expect((await send(app, 'DELETE', `/api/v1/api-tokens/${id}`)).status).toBe(200)

      const rows = await auditRows()
      expect(rows).toMatchObject([
        {
          entityType: 'api_token',
          entityId: id,
          action: 'create',
          userId: TEST_USER_ID,
          changes: { userId: TEST_USER_ID, name: 'CI', authMethod: 'session' },
        },
        {
          entityType: 'api_token',
          entityId: id,
          action: 'revoke',
          userId: TEST_USER_ID,
          changes: { userId: TEST_USER_ID, name: 'CI', authMethod: 'session' },
        },
      ])
      expect(rows[0].changes).toHaveProperty('expiresAt')
      expect(JSON.stringify(rows)).not.toContain(token)
    })

    it('records nothing for a revocation of a token that does not exist', async () => {
      expect((await send(app, 'DELETE', `/api/v1/api-tokens/${MISSING_UUID}`)).status).toBe(404)
      expect(await auditRows()).toEqual([])
    })
  })

  describe('settings', () => {
    it('records a setting change with how its author signed in', async () => {
      const path = '/api/v1/admin/settings/semantic-search-enabled'
      expect((await send(tokenApp, 'PUT', path, { value: false })).status).toBe(200)

      expect(await auditRows()).toMatchObject([
        {
          entityType: 'system_setting',
          action: 'update',
          userId: TEST_USER_ID,
          changes: {
            key: 'semantic-search-enabled',
            value: false,
            previous: null,
            authMethod: 'token',
          },
        },
      ])
    })

    it('records nothing for a value the setting refuses', async () => {
      const path = '/api/v1/admin/settings/vector-similarity-notches'
      expect((await send(app, 'PUT', path, { value: 99 })).status).toBe(400)
      expect(await auditRows()).toEqual([])
    })
  })

  describe('DELETE /admin/data', () => {
    it('records the wipe, which leaves the earlier rows in place', async () => {
      await send(app, 'POST', '/api/v1/organizations', { name: 'gone-org', title: 'Gone' })
      await send(app, 'POST', '/api/v1/organizations/gone-org/members', {
        user_id: OUTSIDER_USER_ID,
        role: 'member',
      })
      expect((await send(app, 'DELETE', '/api/v1/admin/data')).status).toBe(200)

      const rows = await auditRows()
      expect(rows.map((r) => r.action)).toContain('member_add')
      expect(rows.at(-1)).toMatchObject({
        entityType: 'catalog',
        action: 'delete_all',
        userId: TEST_USER_ID,
        changes: { packages: 0, organizations: 1, groups: 0, tags: 0, authMethod: 'session' },
      })
    })
  })
})
