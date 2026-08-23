import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { packageTable, organization as orgTable } from '@kukan/db'
import { createTestApp, mockSearch } from '../test-helpers/test-app'
import {
  getTestDb,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  ensureOutsiderUser,
  OUTSIDER_USER_ID,
} from '../test-helpers/test-db'
import { OrganizationService } from '../../services/organization-service'

// Simulates the worker draining the purge-organization job the route enqueues.
const mockStorage = { deleteByPrefix: async () => 0 } as never
function runOrgPurgeWorker(orgId: string) {
  return new OrganizationService(db).purgeDeletedOrg(orgId, {
    search: mockSearch,
    storage: mockStorage,
  })
}

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

    // Without an ORDER BY the rows come back in whatever order PostgreSQL
    // finds them, so paging could repeat or skip an organization
    describe('ordering', () => {
      async function createOrgs(...names: string[]) {
        for (const name of names) {
          await app.request('/api/v1/organizations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          })
        }
      }

      it('should order by URL identifier by default', async () => {
        await createOrgs('org-charlie', 'org-alpha', 'org-bravo')

        const res = await app.request('/api/v1/organizations')
        const body = await res.json()
        expect(body.items.map((o: { name: string }) => o.name)).toEqual([
          'org-alpha',
          'org-bravo',
          'org-charlie',
        ])
      })

      it('should order by dataset count on request, identifier breaking ties', async () => {
        await createOrgs('org-empty-b', 'org-empty-a', 'org-busy')
        const [busy] = await db
          .select()
          .from(orgTable)
          .where(eq(orgTable.name, 'org-busy'))
          .limit(1)
        await db.insert(packageTable).values({ name: 'pkg-1', title: 'One', ownerOrg: busy.id })

        const res = await app.request('/api/v1/organizations?orderBy=datasetCount')
        const body = await res.json()
        expect(body.items.map((o: { name: string }) => o.name)).toEqual([
          'org-busy',
          'org-empty-a',
          'org-empty-b',
        ])
      })
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
        for (const name of ['org-joined', 'org-other']) {
          await app.request('/api/v1/organizations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          })
        }
        await app.request('/api/v1/organizations/org-joined/members', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: OUTSIDER_USER_ID, role: 'member' }),
        })
      })

      async function listAs(client: typeof app) {
        const body = await (await client.request('/api/v1/organizations')).json()
        return Object.fromEntries(
          body.items.map((o: { name: string; memberCount: number | null }) => [
            o.name,
            o.memberCount,
          ])
        )
      }

      it('should omit counts for anonymous callers', async () => {
        expect(await listAs(createTestApp(db, { user: null }))).toEqual({
          'org-joined': null,
          'org-other': null,
        })
      })

      it('should count only the organizations the viewer belongs to', async () => {
        expect(await listAs(outsiderApp)).toEqual({ 'org-joined': 1, 'org-other': null })
      })

      it('should count every organization for a sysadmin', async () => {
        expect(await listAs(app)).toEqual({ 'org-joined': 1, 'org-other': 0 })
      })
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

    it('should return organization by UUID-shaped name (CKAN uuid slugs)', async () => {
      const uuidName = 'aaaaaaaa-1111-2222-3333-eeeeeeeeeeee'
      await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: uuidName, title: 'UUID Org' }),
      })

      const res = await app.request(`/api/v1/organizations/${uuidName}`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.name).toBe(uuidName)
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
        body: JSON.stringify({ name: 'update-org', title: 'Updated' }),
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.title).toBe('Updated')
    })

    it('should clear omitted optional fields (PUT semantics)', async () => {
      await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'put-clear-org', title: 'Title', description: 'Desc' }),
      })

      // PUT with only name — title and description should be cleared
      const res = await app.request('/api/v1/organizations/put-clear-org', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'put-clear-org' }),
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.title).toBeNull()
      expect(body.description).toBeNull()
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
        body: JSON.stringify({ name: 'auth-update-org', title: 'Hacked' }),
      })
      expect(res.status).toBe(401)
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
      expect(res.status).toBe(401)
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
        body: JSON.stringify({ name: 'no-member-update-org', title: 'Hacked' }),
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

    it('should cascade-purge soft-deleted packages when purging the organization', async () => {
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
        body: JSON.stringify({ name: 'org-linked-pkg', title: 'Linked', ownerOrg: org.id }),
      })

      // Soft-delete the package first: delete() rejects orgs with ACTIVE packages,
      // so the org can only be soft-deleted once its packages are inactive.
      await app.request('/api/v1/packages/org-linked-pkg', { method: 'DELETE' })

      // Soft-delete org (now allowed: no active packages)
      await app.request('/api/v1/organizations/pkg-purge-org', { method: 'DELETE' })

      // The purge route only enqueues; the org stays soft-deleted until the worker runs.
      const res = await app.request('/api/v1/organizations/pkg-purge-org/purge', { method: 'POST' })
      expect(res.status).toBe(200)

      // Still present (pending worker).
      expect(
        await db.select({ id: orgTable.id }).from(orgTable).where(eq(orgTable.id, org.id))
      ).toHaveLength(1)

      // Drain the job: now the package and org are permanently gone.
      const workerResult = await runOrgPurgeWorker(org.id)
      expect(workerResult).toEqual({ purged: true, packageCount: 1 })

      const pkgRows = await db
        .select({ id: packageTable.id })
        .from(packageTable)
        .where(eq(packageTable.name, 'org-linked-pkg'))
      expect(pkgRows).toHaveLength(0)
      expect(
        await db.select({ id: orgTable.id }).from(orgTable).where(eq(orgTable.id, org.id))
      ).toHaveLength(0)
    })

    it('should reject purge when organization still has an active package', async () => {
      const orgRes = await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'active-purge-block-org', title: 'Active Blocks' }),
      })
      const org = await orgRes.json()
      await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'still-active-pkg', title: 'Active', ownerOrg: org.id }),
      })
      // Force the org into 'deleted' state directly (delete() would reject it),
      // to reach purge's own active-package precondition check.
      await db.update(orgTable).set({ state: 'deleted' }).where(eq(orgTable.id, org.id))

      const res = await app.request('/api/v1/organizations/active-purge-block-org/purge', {
        method: 'POST',
      })
      expect(res.status).toBe(409)
    })

    it('should reject soft-delete when organization has active packages', async () => {
      const orgRes = await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'active-pkg-del-org', title: 'Has Active Packages' }),
      })
      const org = await orgRes.json()

      await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'active-linked-pkg', title: 'Active', ownerOrg: org.id }),
      })

      const res = await app.request('/api/v1/organizations/active-pkg-del-org', {
        method: 'DELETE',
      })
      expect(res.status).toBe(409)
    })

    it('should purge a soft-deleted organization (after the worker drains the job)', async () => {
      const orgRes = await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'purge-org', title: 'To Purge' }),
      })
      const org = await orgRes.json()
      await app.request('/api/v1/organizations/purge-org', { method: 'DELETE' })

      const res = await app.request('/api/v1/organizations/purge-org/purge', { method: 'POST' })
      expect(res.status).toBe(200)

      // Route only enqueues — the org row still exists (soft-deleted) until the worker runs.
      expect(
        await db.select({ id: orgTable.id }).from(orgTable).where(eq(orgTable.id, org.id))
      ).toHaveLength(1)

      await runOrgPurgeWorker(org.id)

      // Now permanently gone.
      expect(
        await db.select({ id: orgTable.id }).from(orgTable).where(eq(orgTable.id, org.id))
      ).toHaveLength(0)
    })

    it('worker purge is a no-op when the org was restored before the job ran', async () => {
      const orgRes = await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'restore-race-org', title: 'Restored' }),
      })
      const org = await orgRes.json()
      await app.request('/api/v1/organizations/restore-race-org', { method: 'DELETE' })
      await app.request('/api/v1/organizations/restore-race-org/purge', { method: 'POST' })
      // Restore before the worker drains the enqueued purge job.
      await app.request('/api/v1/organizations/restore-race-org/restore', { method: 'POST' })

      const workerResult = await runOrgPurgeWorker(org.id)
      expect(workerResult).toEqual({ purged: false, packageCount: 0 })

      // The restored (active) org survives.
      const rows = await db
        .select({ state: orgTable.state })
        .from(orgTable)
        .where(eq(orgTable.id, org.id))
      expect(rows[0]?.state).toBe('active')
    })

    it('leaves the org purging (not deleted) when external cleanup fails', async () => {
      const orgRes = await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'cleanup-fail-org', title: 'Cleanup Fails' }),
      })
      const org = await orgRes.json()
      await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'cleanup-fail-pkg', title: 'Linked', ownerOrg: org.id }),
      })
      await app.request('/api/v1/packages/cleanup-fail-pkg', { method: 'DELETE' })
      await app.request('/api/v1/organizations/cleanup-fail-org', { method: 'DELETE' })

      // External cleanup throws → the worker must NOT delete any DB rows.
      const failingSearch = {
        ...mockSearch,
        deletePackage: async () => {
          throw new Error('search down')
        },
      }
      await expect(
        new OrganizationService(db).purgeDeletedOrg(org.id, {
          search: failingSearch,
          storage: mockStorage,
        })
      ).rejects.toThrow('search down')

      // Org stays claimed ('purging', not deleted) and the package survives — safe to retry.
      const orgRow = await db
        .select({ state: orgTable.state })
        .from(orgTable)
        .where(eq(orgTable.id, org.id))
      expect(orgRow[0]?.state).toBe('purging')
      expect(
        await db
          .select({ id: packageTable.id })
          .from(packageTable)
          .where(eq(packageTable.ownerOrg, org.id))
      ).toHaveLength(1)
    })

    it('blocks restore once the org is claimed for purge, and the purge still completes', async () => {
      const orgRes = await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'claimed-org', title: 'Claimed' }),
      })
      const org = await orgRes.json()
      await app.request('/api/v1/organizations/claimed-org', { method: 'DELETE' })

      // Simulate the worker having claimed the org mid-purge (deleted -> purging).
      await db.update(orgTable).set({ state: 'purging' }).where(eq(orgTable.id, org.id))

      // Restore must be refused while purging — its external files may already be gone.
      const restoreRes = await app.request('/api/v1/organizations/claimed-org/restore', {
        method: 'POST',
      })
      expect(restoreRes.status).toBe(404)

      // The purge resumes from 'purging' (idempotent re-claim) and finishes.
      const workerResult = await runOrgPurgeWorker(org.id)
      expect(workerResult.purged).toBe(true)
      expect(
        await db.select({ id: orgTable.id }).from(orgTable).where(eq(orgTable.id, org.id))
      ).toHaveLength(0)
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
