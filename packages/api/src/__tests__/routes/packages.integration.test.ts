import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestApp, mockSearch, mockQueue } from '../test-helpers/test-app'
import {
  getTestDb,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  OUTSIDER_USER_ID,
  ensureOutsiderUser,
} from '../test-helpers/test-db'
import { PostgresSearchAdapter } from '@kukan/search-adapter'
import { ServiceUnavailableError } from '@kukan/shared'
import { packageGroup } from '@kukan/db'

const db = getTestDb()
const search = new PostgresSearchAdapter(db)
const app = createTestApp(db, { search })
const outsiderApp = createTestApp(db, {
  search,
  user: {
    id: OUTSIDER_USER_ID,
    email: 'outsider@example.com',
    name: 'outsider',
    sysadmin: false,
  },
})

let testOrgId: string

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
  await ensureOutsiderUser()
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
    body: JSON.stringify({ ownerOrg: orgId, ...data }),
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

    // my_org backs the dashboard's management listing, so it covers the orgs
    // the viewer may write in — a member-only org's datasets would otherwise
    // be listed for editing and rejected on save (kukan#259)
    describe('my_org scope', () => {
      async function grantMembership(role: string) {
        const orgId = await ensureTestOrg()
        await db.execute(
          sql`INSERT INTO user_org_membership (user_id, organization_id, role)
              VALUES (${OUTSIDER_USER_ID}, ${orgId}, ${role})`
        )
      }

      it('should list the org datasets for an editor', async () => {
        await createPackage({ name: 'editable-pkg' })
        await grantMembership('editor')

        const res = await outsiderApp.request('/api/v1/packages?my_org=true')
        const body = await res.json()
        expect(body.items.map((p: { name: string }) => p.name)).toEqual(['editable-pkg'])
      })

      it('should list nothing for a member who cannot edit them', async () => {
        await createPackage({ name: 'read-only-pkg' })
        await grantMembership('member')

        const res = await outsiderApp.request('/api/v1/packages?my_org=true')
        const body = await res.json()
        expect(body.items).toEqual([])
        expect(body.total).toBe(0)
      })

      it('should keep private datasets visible to a member outside my_org', async () => {
        await createPackage({ name: 'members-private-pkg', private: true })
        await grantMembership('member')

        // Visibility still counts every membership — a member may read the
        // organization's private datasets, they just cannot change them
        const res = await outsiderApp.request('/api/v1/packages')
        const body = await res.json()
        expect(body.items.map((p: { name: string }) => p.name)).toContain('members-private-pkg')
      })
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
        body: JSON.stringify({ name: 'A', ownerOrg: '550e8400-e29b-41d4-a716-446655440000' }),
      })
      expect(res.status).toBe(400)
    })

    it('should create package with groups and return them in detail', async () => {
      // Create groups first
      await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'grp-create-a', title: 'Group A' }),
      })
      await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'grp-create-b', title: 'Group B' }),
      })

      const res = await createPackage({
        name: 'pkg-with-groups',
        groups: [{ name: 'grp-create-a' }, { name: 'grp-create-b' }],
      })
      expect(res.status).toBe(201)

      // Verify groups are returned in detail endpoint
      const detailRes = await app.request('/api/v1/packages/pkg-with-groups')
      const detail = await detailRes.json()
      const groupNames = detail.groups.map((g: { name: string }) => g.name).sort()
      expect(groupNames).toEqual(['grp-create-a', 'grp-create-b'])
    })

    it('should reject non-existent group with 404', async () => {
      const res = await createPackage({
        name: 'pkg-bad-group',
        groups: [{ name: 'no-such-group' }],
      })
      expect(res.status).toBe(404)
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

    it('should return package by UUID-shaped name (CKAN uuid slugs)', async () => {
      const uuidShapedName = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      await createPackage({ name: uuidShapedName, title: 'UUID-named Package' })

      const res = await app.request(`/api/v1/packages/${uuidShapedName}`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.name).toBe(uuidShapedName)
      expect(body.title).toBe('UUID-named Package')
    })

    it('should prefer id over name when same UUID exists in both (CKAN compat)', async () => {
      const sharedUuid = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
      await createPackage({ name: sharedUuid, title: 'Name Match' })
      const idMatchRes = await createPackage({ name: 'id-match-pkg', title: 'ID Match' })
      const idMatchBody = await idMatchRes.json()

      // Overwrite the id to the shared UUID (simulate CKAN import)
      await db.execute(sql`UPDATE package SET id = ${sharedUuid} WHERE id = ${idMatchBody.id}`)

      const res = await app.request(`/api/v1/packages/${sharedUuid}`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.id).toBe(sharedUuid)
      expect(body.title).toBe('ID Match')
    })
  })

  describe('PUT /api/v1/packages/:nameOrId', () => {
    it('should update package', async () => {
      await createPackage({ name: 'update-test', title: 'Original' })
      const orgId = await ensureTestOrg()

      const res = await app.request('/api/v1/packages/update-test', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'update-test', ownerOrg: orgId, title: 'Updated' }),
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.title).toBe('Updated')
    })

    it('should update groups on package', async () => {
      // Create groups
      await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'grp-upd-a', title: 'A' }),
      })
      await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'grp-upd-b', title: 'B' }),
      })
      await app.request('/api/v1/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'grp-upd-c', title: 'C' }),
      })

      await createPackage({
        name: 'grp-update-test',
        groups: [{ name: 'grp-upd-a' }, { name: 'grp-upd-b' }],
      })
      const orgId = await ensureTestOrg()

      // Update: replace groups
      const res = await app.request('/api/v1/packages/grp-update-test', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'grp-update-test',
          ownerOrg: orgId,
          groups: [{ name: 'grp-upd-b' }, { name: 'grp-upd-c' }],
        }),
      })
      expect(res.status).toBe(200)

      const detailRes = await app.request('/api/v1/packages/grp-update-test')
      const detail = await detailRes.json()
      const groupNames = detail.groups.map((g: { name: string }) => g.name).sort()
      expect(groupNames).toEqual(['grp-upd-b', 'grp-upd-c'])
    })

    it('should clear omitted optional fields (PUT semantics)', async () => {
      await createPackage({ name: 'put-clear-test', title: 'Title', notes: 'Notes' })
      const orgId = await ensureTestOrg()

      const res = await app.request('/api/v1/packages/put-clear-test', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'put-clear-test', ownerOrg: orgId }),
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.title).toBeNull()
      expect(body.notes).toBeNull()
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
      await createPackage({ name: 'pkg-cc', licenseId: 'cc-by' })
      await createPackage({ name: 'pkg-mit', licenseId: 'mit' })
      await createPackage({ name: 'pkg-apache', licenseId: 'apache-2.0' })

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
        body: JSON.stringify({ name: 'pkg-alpha', ownerOrg: org1.id }),
      })
      await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'pkg-beta', ownerOrg: org2.id }),
      })
      await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'pkg-gamma', ownerOrg: org3.id }),
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
      expect(res.status).toBe(401)
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

    it('should reject restore when the owner org is not active (purge claim race)', async () => {
      const orgId = await ensureTestOrg()
      await createPackage({ name: 'org-purging-restore-pkg' })
      await app.request('/api/v1/packages/org-purging-restore-pkg', { method: 'DELETE' })

      // Simulate the org being claimed by an in-flight purge (deleted -> purging).
      await db.execute(sql`UPDATE organization SET state = 'purging' WHERE id = ${orgId}`)

      const res = await app.request('/api/v1/packages/org-purging-restore-pkg/restore', {
        method: 'POST',
      })
      expect(res.status).toBe(409)
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

  describe('ownerOrg transfer (SEC-003)', () => {
    it('should reject transfer to org where user is not editor', async () => {
      await createPackage({ name: 'transfer-pkg' })
      const orgId = await ensureTestOrg()

      // Create a second org (outsider has no membership)
      const org2Res = await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'target-org' }),
      })
      const org2 = await org2Res.json()

      // Add outsider as editor in source org so they can initiate the update
      await app.request(`/api/v1/organizations/${orgId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: OUTSIDER_USER_ID, role: 'editor' }),
      })

      // Outsider tries to transfer package to org2 (no membership)
      const res = await outsiderApp.request('/api/v1/packages/transfer-pkg', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'transfer-pkg', ownerOrg: org2.id }),
      })
      expect(res.status).toBe(403)
    })

    it('should allow transfer when user is editor in both orgs', async () => {
      await createPackage({ name: 'transfer-pkg2' })
      const orgId = await ensureTestOrg()

      const org2Res = await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'target-org2' }),
      })
      const org2 = await org2Res.json()

      // Add outsider as editor in both orgs
      await app.request(`/api/v1/organizations/${orgId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: OUTSIDER_USER_ID, role: 'editor' }),
      })
      await app.request(`/api/v1/organizations/${org2.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: OUTSIDER_USER_ID, role: 'editor' }),
      })

      const res = await outsiderApp.request('/api/v1/packages/transfer-pkg2', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'transfer-pkg2', ownerOrg: org2.id }),
      })
      expect(res.status).toBe(200)
    })
  })

  describe('ownerOrg null guard (SEC-005)', () => {
    it('should reject non-sysadmin updating a package without ownerOrg', async () => {
      // Create package via sysadmin, then remove ownerOrg directly in DB
      const createRes = await createPackage({ name: 'no-org-pkg' })
      const pkg = await createRes.json()
      await db.execute(sql`UPDATE package SET owner_org = NULL WHERE id = ${pkg.id}`)

      // Outsider is not a sysadmin — should be rejected regardless of org membership
      const res = await outsiderApp.request('/api/v1/packages/no-org-pkg', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'no-org-pkg', ownerOrg: testOrgId }),
      })
      expect(res.status).toBe(403)
    })

    it('should allow sysadmin to update a package without ownerOrg', async () => {
      const createRes = await createPackage({ name: 'no-org-pkg2' })
      const pkg = await createRes.json()
      await db.execute(sql`UPDATE package SET owner_org = NULL WHERE id = ${pkg.id}`)

      const res = await app.request('/api/v1/packages/no-org-pkg2', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'no-org-pkg2', ownerOrg: testOrgId }),
      })
      expect(res.status).toBe(200)
    })

    it('should reject non-sysadmin deleting a package without ownerOrg', async () => {
      const createRes = await createPackage({ name: 'no-org-del-pkg' })
      const pkg = await createRes.json()
      await db.execute(sql`UPDATE package SET owner_org = NULL WHERE id = ${pkg.id}`)

      const res = await outsiderApp.request('/api/v1/packages/no-org-del-pkg', {
        method: 'DELETE',
      })
      expect(res.status).toBe(403)
    })
  })

  // The search adapter classifies a backend outage (timeout / circuit breaker / node
  // down) as ServiceUnavailableError; the route propagates it as a 503 Problem Details
  // rather than a 500 the client would render as "no results". Unexpected errors stay 500.
  describe('GET /api/v1/packages — search backend failure', () => {
    const unavailableApp = createTestApp(db, {
      search: {
        ...mockSearch,
        search: async () => {
          throw new ServiceUnavailableError('Search is temporarily unavailable')
        },
      },
    })
    const buggyApp = createTestApp(db, {
      search: {
        ...mockSearch,
        search: async () => {
          throw new Error('unexpected parsing bug')
        },
      },
    })

    it('should return 503 Problem Details when the backend is unavailable', async () => {
      const res = await unavailableApp.request('/api/v1/packages?q=anything')
      expect(res.status).toBe(503)

      const body = await res.json()
      expect(body.title).toBe('SERVICE_UNAVAILABLE')
      expect(body.status).toBe(503)
    })

    it('should not mask an unexpected search error as 503 (stays 500)', async () => {
      const res = await buggyApp.request('/api/v1/packages?q=anything')
      expect(res.status).toBe(500)
    })
  })

  describe('Draft packages (ADR-039)', () => {
    const json = (data: Record<string, unknown>) => ({
      method: 'POST' as const,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })

    async function createDraft(data: Record<string, unknown> = {}, requestApp: typeof app = app) {
      const res = await requestApp.request('/api/v1/packages/drafts', json(data))
      expect(res.status).toBe(201)
      return res.json()
    }

    it('should create a draft with a placeholder name from an empty body', async () => {
      const draft = await createDraft()
      expect(draft.state).toBe('draft')
      expect(draft.name).toMatch(/^untitled-[0-9a-f]{8}$/)
      expect(draft.ownerOrg).toBeNull()
    })

    it('should keep drafts out of the public list and default GET', async () => {
      const draft = await createDraft({ name: 'hidden-draft' })

      const list = await app.request('/api/v1/packages')
      expect((await list.json()).total).toBe(0)

      const show = await app.request(`/api/v1/packages/${draft.id}`)
      expect(show.status).toBe(404)

      // CKAN compat show goes through the same active-only path
      const ckan = await app.request(`/api/3/action/package_show?id=${draft.id}`)
      expect(ckan.status).toBe(404)
    })

    it('should show a draft to its creator via state=draft', async () => {
      const draft = await createDraft({}, outsiderApp)

      const show = await outsiderApp.request(`/api/v1/packages/${draft.id}?state=draft`)
      expect(show.status).toBe(200)
      expect((await show.json()).state).toBe('draft')
    })

    it('should hide a draft from non-creators without org access', async () => {
      // Created by the sysadmin test user; the outsider has no membership
      const draft = await createDraft()

      const show = await outsiderApp.request(`/api/v1/packages/${draft.id}?state=draft`)
      expect(show.status).toBe(404)

      const publish = await outsiderApp.request(`/api/v1/packages/${draft.id}/publish`, {
        method: 'POST',
      })
      expect(publish.status).toBe(403)

      const del = await outsiderApp.request(`/api/v1/packages/${draft.id}`, {
        method: 'DELETE',
      })
      expect(del.status).toBe(403)
    })

    it('should list only accessible drafts with state=draft', async () => {
      await createDraft({ name: 'admin-draft' })
      const outsiderDraft = await createDraft({}, outsiderApp)

      const res = await outsiderApp.request('/api/v1/packages?state=draft')
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0].id).toBe(outsiderDraft.id)

      // Sysadmin sees every draft
      const adminRes = await app.request('/api/v1/packages?state=draft')
      expect((await adminRes.json()).total).toBe(2)
    })

    it('should reject publishing without a real name, ownerOrg or license', async () => {
      const draft = await createDraft()

      let res = await app.request(`/api/v1/packages/${draft.id}/publish`, { method: 'POST' })
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toContain('name')

      // Real name, still no ownerOrg
      await app.request(`/api/v1/packages/${draft.id}`, {
        ...json({ name: 'named-draft' }),
        method: 'PUT',
      })
      res = await app.request(`/api/v1/packages/${draft.id}/publish`, { method: 'POST' })
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toContain('organization')

      // Name and ownerOrg set, still no license
      const orgId = await ensureTestOrg()
      await app.request(`/api/v1/packages/${draft.id}`, {
        ...json({ ownerOrg: orgId }),
        method: 'PUT',
      })
      res = await app.request(`/api/v1/packages/${draft.id}/publish`, { method: 'POST' })
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toContain('license')
    })

    it('should publish a complete draft and make it publicly visible', async () => {
      const orgId = await ensureTestOrg()
      const draft = await createDraft({ name: 'ready-draft', ownerOrg: orgId, licenseId: 'cc-by' })

      const res = await app.request(`/api/v1/packages/${draft.id}/publish`, { method: 'POST' })
      expect(res.status).toBe(200)
      expect((await res.json()).state).toBe('active')

      const show = await app.request(`/api/v1/packages/ready-draft`)
      expect(show.status).toBe(200)
    })

    it('should reject publish by a creator who lost editor rights in ownerOrg', async () => {
      const orgId = await ensureTestOrg()
      await app.request(
        `/api/v1/organizations/${orgId}/members`,
        json({ user_id: OUTSIDER_USER_ID, role: 'editor' })
      )
      const draft = await createDraft(
        { name: 'orphaned-creator-draft', ownerOrg: orgId },
        outsiderApp
      )

      // The creator is removed from the org after ownerOrg was set
      await db.execute(
        sql`DELETE FROM user_org_membership
            WHERE user_id = ${OUTSIDER_USER_ID} AND organization_id = ${orgId}`
      )

      const res = await outsiderApp.request(`/api/v1/packages/${draft.id}/publish`, {
        method: 'POST',
      })
      expect(res.status).toBe(403)
    })

    it('should allow publish by an editor of ownerOrg', async () => {
      const orgId = await ensureTestOrg()
      await app.request(
        `/api/v1/organizations/${orgId}/members`,
        json({ user_id: OUTSIDER_USER_ID, role: 'editor' })
      )
      const draft = await createDraft(
        { name: 'editor-publish-draft', ownerOrg: orgId, licenseId: 'cc-by' },
        outsiderApp
      )

      const res = await outsiderApp.request(`/api/v1/packages/${draft.id}/publish`, {
        method: 'POST',
      })
      expect(res.status).toBe(200)
      expect((await res.json()).state).toBe('active')
    })

    it('should allow re-publishing an active package and re-run the sync (idempotent)', async () => {
      const orgId = await ensureTestOrg()
      const draft = await createDraft({
        name: 'republish-draft',
        ownerOrg: orgId,
        licenseId: 'cc-by',
      })

      const first = await app.request(`/api/v1/packages/${draft.id}/publish`, { method: 'POST' })
      expect(first.status).toBe(200)

      // A second publish is the retry entry point for a failed publish-time sync
      const indexSpy = vi.spyOn(search, 'indexPackage')
      try {
        const again = await app.request(`/api/v1/packages/${draft.id}/publish`, {
          method: 'POST',
        })
        expect(again.status).toBe(200)
        expect((await again.json()).state).toBe('active')
        expect(indexSpy).toHaveBeenCalledWith(expect.objectContaining({ id: draft.id }))
      } finally {
        indexSpy.mockRestore()
      }
    })

    it('should fail publish when the pipeline enqueue fails, and allow a retry', async () => {
      const orgId = await ensureTestOrg()
      const draft = await createDraft({
        name: 'enqueue-fail-draft',
        ownerOrg: orgId,
        licenseId: 'cc-by',
      })
      const resourceRes = await createResource(draft.id, {
        url: 'https://example.com/data.csv',
        format: 'CSV',
        name: 'linked data',
      })
      expect(resourceRes.status).toBe(201)

      // Queue outage: publish must not report success while the content
      // indexing job was never enqueued
      const enqueueMock = vi.mocked(mockQueue.enqueue)
      enqueueMock.mockRejectedValueOnce(new Error('queue unavailable'))
      const failed = await app.request(`/api/v1/packages/${draft.id}/publish`, { method: 'POST' })
      expect(failed.status).toBe(500)

      // The transition itself committed — the same request is the retry path
      const callsAfterFailure = enqueueMock.mock.calls.length
      const retried = await app.request(`/api/v1/packages/${draft.id}/publish`, { method: 'POST' })
      expect(retried.status).toBe(200)
      expect((await retried.json()).state).toBe('active')
      expect(enqueueMock.mock.calls.length).toBeGreaterThan(callsAfterFailure)
    })

    it('should return 404 when publishing a deleted or purging package', async () => {
      const pkgRes = await createPackage({ name: 'publish-deleted-pkg' })
      const pkg = await pkgRes.json()
      await app.request(`/api/v1/packages/${pkg.id}`, { method: 'DELETE' })

      const deleted = await app.request(`/api/v1/packages/${pkg.id}/publish`, { method: 'POST' })
      expect(deleted.status).toBe(404)

      await db.execute(sql`UPDATE package SET state = 'purging' WHERE id = ${pkg.id}`)
      const purging = await app.request(`/api/v1/packages/${pkg.id}/publish`, { method: 'POST' })
      expect(purging.status).toBe(404)
    })

    it('should update a draft without name/ownerOrg but require them for active packages', async () => {
      const draft = await createDraft()
      const res = await app.request(`/api/v1/packages/${draft.id}`, {
        ...json({ title: 'WIP title' }),
        method: 'PUT',
      })
      expect(res.status).toBe(200)
      expect((await res.json()).title).toBe('WIP title')

      const pkgRes = await createPackage({ name: 'strict-pkg' })
      const pkg = await pkgRes.json()
      const bad = await app.request(`/api/v1/packages/${pkg.id}`, {
        ...json({ title: 'no name' }),
        method: 'PUT',
      })
      expect(bad.status).toBe(400)
    })

    it('should apply a partial PUT to a draft without wiping unspecified fields', async () => {
      const orgId = await ensureTestOrg()
      const draft = await createDraft({
        name: 'partial-put-draft',
        ownerOrg: orgId,
        notes: 'keep these notes',
        private: true,
        extras: { source: 'survey' },
        tags: [{ name: 'draft-tag' }],
      })

      const res = await app.request(`/api/v1/packages/${draft.id}`, {
        ...json({ title: 'WIP title only' }),
        method: 'PUT',
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.title).toBe('WIP title only')
      expect(body.notes).toBe('keep these notes')
      expect(body.private).toBe(true)
      expect(body.extras).toEqual({ source: 'survey' })
      expect(body.name).toBe('partial-put-draft')
      expect(body.ownerOrg).toBe(orgId)

      const detail = await app.request(`/api/v1/packages/${draft.id}?state=draft`)
      const detailBody = await detail.json()
      expect(detailBody.tags.map((t: { name: string }) => t.name)).toEqual(['draft-tag'])

      // Explicit null still clears a field on a draft
      const clear = await app.request(`/api/v1/packages/${draft.id}`, {
        ...json({ notes: null }),
        method: 'PUT',
      })
      expect(clear.status).toBe(200)
      expect((await clear.json()).notes).toBeNull()
    })

    it('should reset a draft name to a fresh placeholder via name: null and re-block publish', async () => {
      const orgId = await ensureTestOrg()
      const draft = await createDraft({
        name: 'reset-name-draft',
        ownerOrg: orgId,
        licenseId: 'cc-by',
      })

      const res = await app.request(`/api/v1/packages/${draft.id}`, {
        ...json({ name: null }),
        method: 'PUT',
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.name).toMatch(/^untitled-[0-9a-f]{8}$/)
      expect(body.name).not.toBe('reset-name-draft')

      // Back to "unnamed": the publish gate blocks the draft again
      const publish = await app.request(`/api/v1/packages/${draft.id}/publish`, { method: 'POST' })
      expect(publish.status).toBe(400)

      // Active packages reject an explicit null name
      const pkgRes = await createPackage({ name: 'null-name-active-pkg' })
      const pkg = await pkgRes.json()
      const bad = await app.request(`/api/v1/packages/${pkg.id}`, {
        ...json({ name: null, ownerOrg: pkg.ownerOrg }),
        method: 'PUT',
      })
      expect(bad.status).toBe(400)
    })

    it('should apply q, organization, and sort filters to the draft listing', async () => {
      const orgId = await ensureTestOrg()
      await createDraft({ name: 'draft-population', title: 'Population Draft' })
      await createDraft({ name: 'draft-weather', ownerOrg: orgId })

      const byQ = await app.request('/api/v1/packages?state=draft&q=population')
      const qBody = await byQ.json()
      expect(qBody.total).toBe(1)
      expect(qBody.items[0].name).toBe('draft-population')

      const byOrg = await app.request('/api/v1/packages?state=draft&organization=test-org-pkg')
      const orgBody = await byOrg.json()
      expect(orgBody.total).toBe(1)
      expect(orgBody.items[0].name).toBe('draft-weather')

      const ascRes = await app.request('/api/v1/packages?state=draft&sort_by=name&sort_order=asc')
      expect((await ascRes.json()).items.map((i: { name: string }) => i.name)).toEqual([
        'draft-population',
        'draft-weather',
      ])
      const descRes = await app.request('/api/v1/packages?state=draft&sort_by=name&sort_order=desc')
      expect((await descRes.json()).items.map((i: { name: string }) => i.name)).toEqual([
        'draft-weather',
        'draft-population',
      ])
    })

    it('should reject unsupported filters on the draft listing', async () => {
      const res = await app.request('/api/v1/packages?state=draft&tags=env&my_org=true')
      expect(res.status).toBe(400)
      const detail = (await res.json()).detail
      expect(detail).toContain('tags')
      expect(detail).toContain('my_org')
    })

    it('should clear ownerOrg on a draft with explicit null but reject it for active packages', async () => {
      const orgId = await ensureTestOrg()
      const draft = await createDraft({ name: 'clear-org-draft', ownerOrg: orgId })

      const res = await app.request(`/api/v1/packages/${draft.id}`, {
        ...json({ ownerOrg: null }),
        method: 'PUT',
      })
      expect(res.status).toBe(200)
      expect((await res.json()).ownerOrg).toBeNull()

      const pkgRes = await createPackage({ name: 'active-null-org-pkg' })
      const pkg = await pkgRes.json()
      const bad = await app.request(`/api/v1/packages/${pkg.id}`, {
        ...json({ name: 'active-null-org-pkg', ownerOrg: null }),
        method: 'PUT',
      })
      expect(bad.status).toBe(400)
    })

    it('should keep full-replacement PUT semantics for active packages', async () => {
      await createPackage({
        name: 'active-replace-pkg',
        title: 'Original',
        private: true,
        extras: { a: 1 },
        tags: [{ name: 'old-tag' }],
      })
      const orgId = await ensureTestOrg()

      const res = await app.request('/api/v1/packages/active-replace-pkg', {
        ...json({ name: 'active-replace-pkg', ownerOrg: orgId }),
        method: 'PUT',
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.title).toBeNull()
      expect(body.private).toBe(false)
      expect(body.extras).toEqual({})

      const detail = await app.request('/api/v1/packages/active-replace-pkg')
      expect((await detail.json()).tags).toEqual([])
    })

    it('should not leak draft-only tags and formats into public aggregates', async () => {
      const pkgRes = await createPackage({
        name: 'facet-active-pkg',
        tags: [{ name: 'public-tag' }],
      })
      const pkg = await pkgRes.json()
      await createResource(pkg.id, { name: 'a.csv', format: 'CSV' })

      const orgId = await ensureTestOrg()
      const draft = await createDraft({
        name: 'facet-draft-pkg',
        ownerOrg: orgId,
        tags: [{ name: 'draft-only-tag' }],
      })
      await createResource(draft.id, { name: 'd.pdf', format: 'PDF' })

      const formatsRes = await app.request('/api/v1/resources/formats')
      const formats = await formatsRes.json()
      expect(formats).toContain('CSV')
      expect(formats).not.toContain('PDF')

      const listRes = await app.request('/api/v1/packages?include_facets=true')
      const facets = (await listRes.json()).facets
      const tagNames = facets.tags.map((t: { name: string }) => t.name)
      expect(tagNames).toContain('public-tag')
      expect(tagNames).not.toContain('draft-only-tag')
      const formatNames = facets.formats.map((f: { name: string }) => f.name)
      expect(formatNames).toContain('CSV')
      expect(formatNames).not.toContain('PDF')
    })

    it('should order facets by count, not by name', async () => {
      // Enriching with every active organization used to drop the counts'
      // order, leaving an empty organization above a used one (#261)
      const usedOrg = await ensureTestOrg()
      await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Sorts before the used org by name and by title, so only the count
        // ordering can put it second
        body: JSON.stringify({ name: 'aaa-empty-org', title: 'AAA Empty Org' }),
      })
      await createPackage({ name: 'facet-order-pkg', ownerOrg: usedOrg })

      const res = await app.request('/api/v1/packages?include_facets=true')
      const { organizations } = (await res.json()).facets

      expect(organizations[0].count).toBeGreaterThan(0)
      expect(organizations.at(-1)).toMatchObject({ name: 'aaa-empty-org', count: 0 })
    })

    it('should accept resources on a draft and restrict their visibility', async () => {
      const draft = await createDraft({}, outsiderApp)
      const resRes = await outsiderApp.request(
        `/api/v1/packages/${draft.id}/resources`,
        json({ name: 'draft-file.csv', format: 'CSV' })
      )
      expect(resRes.status).toBe(201)
      const resource = await resRes.json()

      // Creator can list and read
      const list = await outsiderApp.request(`/api/v1/packages/${draft.id}/resources`)
      expect(list.status).toBe(200)
      expect(await list.json()).toHaveLength(1)

      const mine = await outsiderApp.request(`/api/v1/resources/${resource.id}`)
      expect(mine.status).toBe(200)

      // Anonymous viewers get 404
      const anonApp = createTestApp(db, { search, user: null })
      const anon = await anonApp.request(`/api/v1/resources/${resource.id}`)
      expect(anon.status).toBe(404)
    })

    it('should not count draft packages in group dataset counts', async () => {
      await app.request('/api/v1/groups', json({ name: 'draft-grp', title: 'Draft Group' }))
      await createDraft({ groups: [{ name: 'draft-grp' }] })

      const res = await app.request('/api/v1/groups')
      const body = await res.json()
      const grp = body.items.find((g: { name: string }) => g.name === 'draft-grp')
      expect(grp.datasetCount).toBe(0)
    })

    it('should hard-delete a draft on DELETE (no trash)', async () => {
      const draft = await createDraft({ name: 'delete-me' })

      const del = await app.request(`/api/v1/packages/${draft.id}`, { method: 'DELETE' })
      expect(del.status).toBe(200)

      // Gone entirely — not in the trash either
      const showDeleted = await app.request(`/api/v1/packages/${draft.id}?state=deleted`)
      expect(showDeleted.status).toBe(404)
      const showDraft = await app.request(`/api/v1/packages/${draft.id}?state=draft`)
      expect(showDraft.status).toBe(404)
    })

    it('should surface purging rows in the draft listing for delete retry', async () => {
      // Crashed purge of the outsider's draft (row left 'purging')
      const stuck = await createDraft({ name: 'stuck-purge' }, outsiderApp)
      await db.execute(sql`UPDATE package SET state = 'purging' WHERE id = ${stuck.id}`)
      // A purging row of another creator must stay invisible
      const adminStuck = await createDraft({ name: 'admin-stuck-purge' })
      await db.execute(sql`UPDATE package SET state = 'purging' WHERE id = ${adminStuck.id}`)

      const res = await outsiderApp.request('/api/v1/packages?state=draft')
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0].id).toBe(stuck.id)
      expect(body.items[0].state).toBe('purging')

      // The edit path stays closed — the ?state=draft detail is draft-only
      const detail = await outsiderApp.request(`/api/v1/packages/${stuck.id}?state=draft`)
      expect(detail.status).toBe(404)
    })

    it('should finish purging a crashed draft purge on DELETE re-run', async () => {
      const draft = await createDraft({ name: 'crashed-purge' })

      // Simulate a purge that crashed after the claim (row left 'purging')
      await db.execute(sql`UPDATE package SET state = 'purging' WHERE id = ${draft.id}`)

      const del = await app.request(`/api/v1/packages/${draft.id}`, { method: 'DELETE' })
      expect(del.status).toBe(200)

      const rows = await db.execute(sql`SELECT state FROM package WHERE id = ${draft.id}`)
      expect(rows.rows).toHaveLength(0)
    })
  })
})
