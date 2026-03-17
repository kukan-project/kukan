import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createTestApp } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'

const db = getTestDb()
const app = createTestApp(db)

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

  describe('Private package visibility', () => {
    it('should hide private packages from unauthenticated list', async () => {
      await createPackage({ name: 'public-pkg', private: false })
      await createPackage({ name: 'private-pkg', private: true })

      const noAuthApp = createTestApp(db, { user: null })
      const res = await noAuthApp.request('/api/v1/packages')
      const body = await res.json()

      expect(body.total).toBe(1)
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

      const noAuthApp = createTestApp(db, { user: null })
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
})
