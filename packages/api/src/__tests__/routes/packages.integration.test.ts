import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestApp } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'
import { PostgresSearchAdapter } from '@kukan/search-adapter'
import { packageGroup } from '@kukan/db'

const db = getTestDb()
const search = new PostgresSearchAdapter(db)
const app = createTestApp(db, { search })

let testOrgId: string

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
  testOrgId = undefined as unknown as string
})

afterAll(async () => {
  await closeTestDb()
})

async function ensureTestOrg() {
  if (testOrgId) return testOrgId
  const res = await app.request('/api/v1/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-org-pkg' }),
  })
  const org = await res.json()
  testOrgId = org.id
  return testOrgId
}

async function createPackage(data: Record<string, unknown>) {
  const orgId = await ensureTestOrg()
  return app.request('/api/v1/packages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner_org: orgId, ...data }),
  })
}

async function createResource(packageId: string, data: Record<string, unknown>) {
  return app.request(`/api/v1/packages/${packageId}/resources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

describe('Packages API Routes', () => {
  describe('GET /api/v1/packages', () => {
    it('should return 200 with empty list', async () => {
      const res = await app.request('/api/v1/packages')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.items).toEqual([])
      expect(body.total).toBe(0)
    })

    it('should return paginated list after creating packages', async () => {
      await createPackage({ name: 'pkg-one' })
      await createPackage({ name: 'pkg-two' })

      const res = await app.request('/api/v1/packages')
      const body = await res.json()
      expect(body.total).toBe(2)
      expect(body.items).toHaveLength(2)
    })

    it('should filter by q parameter', async () => {
      await createPackage({ name: 'population-data', title: 'Population Statistics' })
      await createPackage({ name: 'weather-data' })

      const res = await app.request('/api/v1/packages?q=population')
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0].name).toBe('population-data')
    })

    it('should find packages by resource name and include matchedResources', async () => {
      const pkgRes = await createPackage({ name: 'res-search-pkg', title: 'Some Dataset' })
      const pkg = await pkgRes.json()
      await createResource(pkg.id, {
        name: 'quarterly-report.csv',
        description: 'Q1 revenue data',
        format: 'CSV',
      })

      // Another package without matching resource
      await createPackage({ name: 'unrelated-pkg', title: 'Unrelated' })

      const res = await app.request('/api/v1/packages?q=quarterly-report')
      const body = await res.json()

      expect(body.total).toBe(1)
      expect(body.items[0].name).toBe('res-search-pkg')
      expect(body.items[0].matchedResources).toBeDefined()
      expect(body.items[0].matchedResources).toHaveLength(1)
      expect(body.items[0].matchedResources[0].name).toBe('quarterly-report.csv')
      expect(body.items[0].matchedResources[0].format).toBe('CSV')
    })

    it('should not include matchedResources when q is absent', async () => {
      const pkgRes = await createPackage({ name: 'no-q-pkg' })
      const pkg = await pkgRes.json()
      await createResource(pkg.id, { name: 'some-file.csv', format: 'CSV' })

      const res = await app.request('/api/v1/packages')
      const body = await res.json()

      expect(body.items[0].matchedResources).toBeUndefined()
    })
  })

  describe('POST /api/v1/packages', () => {
    it('should create package and return 201', async () => {
      const res = await createPackage({
        name: 'new-dataset',
        title: 'New Dataset',
        notes: 'A test dataset',
      })
      expect(res.status).toBe(201)

      const body = await res.json()
      expect(body.name).toBe('new-dataset')
      expect(body.title).toBe('New Dataset')
      expect(body.state).toBe('active')
      expect(body.id).toBeDefined()
    })

    it('should reject invalid name with 400', async () => {
      const res = await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'A', owner_org: '550e8400-e29b-41d4-a716-446655440000' }),
      })
      expect(res.status).toBe(400)
    })

    it('should reject duplicate name with 400', async () => {
      await createPackage({ name: 'duplicate-pkg' })

      const res = await createPackage({ name: 'duplicate-pkg' })
      expect(res.status).toBe(400)

      const body = await res.json()
      expect(body.detail).toContain('already exists')
    })
  })

  describe('GET /api/v1/packages/:nameOrId', () => {
    it('should return package by name', async () => {
      await createPackage({ name: 'by-name-test' })

      const res = await app.request('/api/v1/packages/by-name-test')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.name).toBe('by-name-test')
    })

    it('should return package by UUID', async () => {
      const createRes = await createPackage({ name: 'by-uuid-test' })
      const created = await createRes.json()

      const res = await app.request(`/api/v1/packages/${created.id}`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.id).toBe(created.id)
    })

    it('should return 404 for non-existent package', async () => {
      const res = await app.request('/api/v1/packages/does-not-exist')
      expect(res.status).toBe(404)
    })
  })

  describe('PUT /api/v1/packages/:nameOrId', () => {
    it('should update package', async () => {
      await createPackage({ name: 'update-test', title: 'Original' })

      const res = await app.request('/api/v1/packages/update-test', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'update-test', title: 'Updated' }),
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.title).toBe('Updated')
    })
  })

  describe('PATCH /api/v1/packages/:nameOrId', () => {
    it('should partially update package', async () => {
      await createPackage({ name: 'patch-test', title: 'Original', notes: 'Keep this' })

      const res = await app.request('/api/v1/packages/patch-test', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Patched' }),
      })
      expect(res.status).toBe(200)

      // Verify notes was preserved
      const getRes = await app.request('/api/v1/packages/patch-test')
      const body = await getRes.json()
      expect(body.title).toBe('Patched')
      expect(body.notes).toBe('Keep this')
    })
  })

  describe('DELETE /api/v1/packages/:nameOrId', () => {
    it('should soft delete package', async () => {
      await createPackage({ name: 'delete-test' })

      const res = await app.request('/api/v1/packages/delete-test', { method: 'DELETE' })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.state).toBe('deleted')
    })

    it('should not appear in list after deletion', async () => {
      await createPackage({ name: 'will-delete' })

      await app.request('/api/v1/packages/will-delete', { method: 'DELETE' })

      const listRes = await app.request('/api/v1/packages')
      const body = await listRes.json()
      expect(body.total).toBe(0)
    })

    it('should return 404 for non-existent package', async () => {
      const res = await app.request('/api/v1/packages/no-such-pkg', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/v1/packages/:id/resources', () => {
    it('should list resources for a package', async () => {
      const createRes = await createPackage({ name: 'res-list-test' })
      const pkg = await createRes.json()

      const res = await app.request(`/api/v1/packages/${pkg.id}/resources`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toEqual([])
    })
  })

  describe('POST /api/v1/packages/:id/resources', () => {
    it('should create resource for package', async () => {
      const createRes = await createPackage({ name: 'res-create-test' })
      const pkg = await createRes.json()

      const res = await app.request(`/api/v1/packages/${pkg.id}/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test-resource', format: 'CSV' }),
      })
      expect(res.status).toBe(201)

      const body = await res.json()
      expect(body.name).toBe('test-resource')
      expect(body.position).toBe(0)
    })
  })

  describe('Multi-value AND/OR filters', () => {
    async function createOrg(name: string) {
      const res = await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      return res.json()
    }

    async function createGroup(name: string) {
      const res = await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, title: name }),
      })
      return res.json()
    }

    it('should AND filter tags — only packages with ALL selected tags', async () => {
      await createPackage({ name: 'pkg-ab', tags: [{ name: 'env' }, { name: 'health' }] })
      await createPackage({ name: 'pkg-ac', tags: [{ name: 'env' }, { name: 'transport' }] })
      await createPackage({ name: 'pkg-bc', tags: [{ name: 'health' }, { name: 'education' }] })

      const res = await app.request('/api/v1/packages?tags=env&tags=health')
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0].name).toBe('pkg-ab')
    })

    it('should return all matching packages for single tag filter', async () => {
      await createPackage({ name: 'pkg-x', tags: [{ name: 'env' }] })
      await createPackage({ name: 'pkg-y', tags: [{ name: 'env' }, { name: 'health' }] })
      await createPackage({ name: 'pkg-z', tags: [{ name: 'health' }] })

      const res = await app.request('/api/v1/packages?tags=env')
      const body = await res.json()
      expect(body.total).toBe(2)
    })

    it('should AND filter formats — only packages with ALL selected formats', async () => {
      const resA = await createPackage({ name: 'pkg-csv-json' })
      const pkgA = await resA.json()
      await createResource(pkgA.id, { name: 'a.csv', format: 'CSV' })
      await createResource(pkgA.id, { name: 'a.json', format: 'JSON' })

      const resB = await createPackage({ name: 'pkg-csv-only' })
      const pkgB = await resB.json()
      await createResource(pkgB.id, { name: 'b.csv', format: 'CSV' })

      const resC = await createPackage({ name: 'pkg-json-only' })
      const pkgC = await resC.json()
      await createResource(pkgC.id, { name: 'c.json', format: 'JSON' })

      const res = await app.request('/api/v1/packages?res_format=CSV&res_format=JSON')
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0].name).toBe('pkg-csv-json')
    })

    it('should OR filter licenses — packages with ANY selected license', async () => {
      await createPackage({ name: 'pkg-cc', license_id: 'cc-by' })
      await createPackage({ name: 'pkg-mit', license_id: 'mit' })
      await createPackage({ name: 'pkg-apache', license_id: 'apache-2.0' })

      const res = await app.request('/api/v1/packages?license_id=cc-by&license_id=mit')
      const body = await res.json()
      expect(body.total).toBe(2)
      const names = body.items.map((i: { name: string }) => i.name).sort()
      expect(names).toEqual(['pkg-cc', 'pkg-mit'])
    })

    it('should OR filter organizations — packages from ANY selected org', async () => {
      const org1 = await createOrg('filter-org-alpha')
      const org2 = await createOrg('filter-org-beta')
      const org3 = await createOrg('filter-org-gamma')

      await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'pkg-alpha', owner_org: org1.id }),
      })
      await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'pkg-beta', owner_org: org2.id }),
      })
      await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'pkg-gamma', owner_org: org3.id }),
      })

      const res = await app.request(
        '/api/v1/packages?organization=filter-org-alpha&organization=filter-org-beta'
      )
      const body = await res.json()
      expect(body.total).toBe(2)
      const names = body.items.map((i: { name: string }) => i.name).sort()
      expect(names).toEqual(['pkg-alpha', 'pkg-beta'])
    })

    it('should AND filter groups — only packages in ALL selected groups', async () => {
      const grp1 = await createGroup('environment')
      const grp2 = await createGroup('transport')
      const grp3 = await createGroup('health')

      const resA = await createPackage({ name: 'pkg-env-trans' })
      const pkgA = await resA.json()
      const resB = await createPackage({ name: 'pkg-env-only' })
      const pkgB = await resB.json()
      const resC = await createPackage({ name: 'pkg-trans-health' })
      const pkgC = await resC.json()

      await db.insert(packageGroup).values([
        { packageId: pkgA.id, groupId: grp1.id },
        { packageId: pkgA.id, groupId: grp2.id },
        { packageId: pkgB.id, groupId: grp1.id },
        { packageId: pkgC.id, groupId: grp2.id },
        { packageId: pkgC.id, groupId: grp3.id },
      ])

      const res = await app.request('/api/v1/packages?groups=environment&groups=transport')
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0].name).toBe('pkg-env-trans')
    })

    it('should AND across categories — tags AND formats', async () => {
      const resA = await createPackage({ name: 'pkg-env-csv', tags: [{ name: 'env' }] })
      const pkgA = await resA.json()
      await createResource(pkgA.id, { name: 'a.csv', format: 'CSV' })

      const resB = await createPackage({ name: 'pkg-env-json', tags: [{ name: 'env' }] })
      const pkgB = await resB.json()
      await createResource(pkgB.id, { name: 'b.json', format: 'JSON' })

      const resC = await createPackage({ name: 'pkg-health-csv', tags: [{ name: 'health' }] })
      const pkgC = await resC.json()
      await createResource(pkgC.id, { name: 'c.csv', format: 'CSV' })

      const res = await app.request('/api/v1/packages?tags=env&res_format=CSV')
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0].name).toBe('pkg-env-csv')
    })

    it('should return empty when AND conditions cannot be satisfied', async () => {
      await createPackage({ name: 'pkg-a', tags: [{ name: 'env' }] })
      await createPackage({ name: 'pkg-b', tags: [{ name: 'health' }] })

      const res = await app.request('/api/v1/packages?tags=env&tags=health')
      const body = await res.json()
      expect(body.total).toBe(0)
    })
  })

  describe('Private package visibility', () => {
    it('should hide private packages from unauthenticated list', async () => {
      await createPackage({ name: 'public-pkg', private: false })
      await createPackage({ name: 'private-pkg', private: true })

      const noAuthApp = createTestApp(db, { user: null, search })
      const res = await noAuthApp.request('/api/v1/packages')
      const body = await res.json()

      expect(body.total).toBe(1)
      expect(body.items).toHaveLength(1)
      expect(body.items[0].name).toBe('public-pkg')
    })

    it('should show private packages to sysadmin in list', async () => {
      await createPackage({ name: 'public-pkg2', private: false })
      await createPackage({ name: 'private-pkg2', private: true })

      const res = await app.request('/api/v1/packages')
      const body = await res.json()

      expect(body.total).toBe(2)
    })

    it('should return 404 for private package detail to unauthenticated user', async () => {
      await createPackage({ name: 'secret-pkg', private: true })

      const noAuthApp = createTestApp(db, { user: null, search })
      const res = await noAuthApp.request('/api/v1/packages/secret-pkg')
      expect(res.status).toBe(404)
    })

    it('should return 404 for private package detail to non-member', async () => {
      await createPackage({ name: 'secret-pkg2', private: true })

      const regularApp = createTestApp(db, {
        user: {
          id: '00000000-0000-0000-0000-000000000099',
          email: 'regular@example.com',
          name: 'regular',
          sysadmin: false,
        },
      })
      const res = await regularApp.request('/api/v1/packages/secret-pkg2')
      expect(res.status).toBe(404)
    })

    it('should show private package detail to sysadmin', async () => {
      await createPackage({ name: 'secret-pkg3', private: true })

      const res = await app.request('/api/v1/packages/secret-pkg3')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.name).toBe('secret-pkg3')
    })
  })

  describe('POST /api/v1/packages/:nameOrId/restore', () => {
    it('should reject unauthenticated requests', async () => {
      const unauthApp = createTestApp(db, { user: null, search })
      const res = await unauthApp.request('/api/v1/packages/any-pkg/restore', { method: 'POST' })
      expect(res.status).toBe(403)
    })

    it('should reject restore by org editor (requires admin+)', async () => {
      await createPackage({ name: 'editor-restore-pkg' })
      await app.request('/api/v1/packages/editor-restore-pkg', { method: 'DELETE' })

      // Create an editor user
      const editorId = '00000000-0000-0000-0000-000000000097'
      await db.execute(
        sql`INSERT INTO "user" (id, name, email, "emailVerified", state, role, "createdAt", "updatedAt")
            VALUES (${editorId}, 'editor-user', 'editor@example.com', false, 'active', 'user', NOW(), NOW())
            ON CONFLICT (id) DO NOTHING`
      )
      await db.execute(
        sql`INSERT INTO user_org_membership (user_id, organization_id, role)
            VALUES (${editorId}, ${testOrgId}, 'editor')
            ON CONFLICT DO NOTHING`
      )

      const editorApp = createTestApp(db, {
        user: {
          id: editorId,
          email: 'editor@example.com',
          name: 'editor-user',
          sysadmin: false,
        },
        search,
      })

      const res = await editorApp.request('/api/v1/packages/editor-restore-pkg/restore', {
        method: 'POST',
      })
      expect(res.status).toBe(403)
    })

    it('should restore a soft-deleted package', async () => {
      await createPackage({ name: 'restore-pkg' })

      // Soft-delete
      const deleteRes = await app.request('/api/v1/packages/restore-pkg', { method: 'DELETE' })
      expect(deleteRes.status).toBe(200)

      // Restore
      const restoreRes = await app.request('/api/v1/packages/restore-pkg/restore', {
        method: 'POST',
      })
      expect(restoreRes.status).toBe(200)
      const body = await restoreRes.json()
      expect(body.state).toBe('active')

      // Verify it's visible again
      const getRes = await app.request('/api/v1/packages/restore-pkg')
      expect(getRes.status).toBe(200)
    })

    it('should return 404 for active package', async () => {
      await createPackage({ name: 'active-restore-pkg' })

      const res = await app.request('/api/v1/packages/active-restore-pkg/restore', {
        method: 'POST',
      })
      expect(res.status).toBe(404) // getByNameOrId with state='deleted' throws NotFound
    })

    it('should return 404 for non-existent package', async () => {
      const res = await app.request('/api/v1/packages/non-existent/restore', { method: 'POST' })
      expect(res.status).toBe(404)
    })

    it('should re-index package in search after restore', async () => {
      await createPackage({ name: 'reindex-restore-pkg' })

      await app.request('/api/v1/packages/reindex-restore-pkg', { method: 'DELETE' })

      // Search should not find it
      const searchBefore = await app.request('/api/v1/packages?q=reindex-restore-pkg')
      const beforeBody = await searchBefore.json()
      expect(beforeBody.items).toHaveLength(0)

      // Restore
      await app.request('/api/v1/packages/reindex-restore-pkg/restore', { method: 'POST' })

      // Search should find it again
      const searchAfter = await app.request('/api/v1/packages?q=reindex-restore-pkg')
      const afterBody = await searchAfter.json()
      expect(afterBody.items.length).toBeGreaterThan(0)
    })
  })

  describe('Deleted package access control', () => {
    it('should deny non-member access to deleted public package', async () => {
      await createPackage({ name: 'deleted-access-pkg' })

      // Soft-delete
      await app.request('/api/v1/packages/deleted-access-pkg', { method: 'DELETE' })

      // Non-member user tries to access deleted package
      const otherUserApp = createTestApp(db, {
        user: {
          id: '00000000-0000-0000-0000-000000000099',
          email: 'other@example.com',
          name: 'other-user',
          sysadmin: false,
        },
        search,
      })

      const res = await otherUserApp.request('/api/v1/packages/deleted-access-pkg?state=deleted')
      expect(res.status).toBe(404)
    })

    it('should allow org member access to deleted package', async () => {
      await createPackage({ name: 'deleted-member-pkg' })

      await app.request('/api/v1/packages/deleted-member-pkg', { method: 'DELETE' })

      // Create a member user and add to the org as 'member' role
      const memberId = '00000000-0000-0000-0000-000000000098'
      await db.execute(
        sql`INSERT INTO "user" (id, name, email, "emailVerified", state, role, "createdAt", "updatedAt")
            VALUES (${memberId}, 'member-user', 'member@example.com', false, 'active', 'user', NOW(), NOW())
            ON CONFLICT (id) DO NOTHING`
      )
      await db.execute(
        sql`INSERT INTO user_org_membership (user_id, organization_id, role)
            VALUES (${memberId}, ${testOrgId}, 'member')
            ON CONFLICT DO NOTHING`
      )

      const memberApp = createTestApp(db, {
        user: {
          id: memberId,
          email: 'member@example.com',
          name: 'member-user',
          sysadmin: false,
        },
        search,
      })

      const res = await memberApp.request('/api/v1/packages/deleted-member-pkg?state=deleted')
      expect(res.status).toBe(200)
    })

    it('should allow sysadmin access to deleted package', async () => {
      await createPackage({ name: 'deleted-admin-pkg' })

      await app.request('/api/v1/packages/deleted-admin-pkg', { method: 'DELETE' })

      // sysadmin (default test user) should be able to access
      const res = await app.request('/api/v1/packages/deleted-admin-pkg?state=deleted')
      expect(res.status).toBe(200)
    })
  })
})
