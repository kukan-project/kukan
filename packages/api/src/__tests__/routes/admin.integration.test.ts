import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
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
  getIndexStats: async () => null,
  getDocument: async () => null,
  browseDocuments: async () => null,
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
  vi.mocked(mockSearch.bulkIndexPackages).mockClear()
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

/** Create a package with a resource via API */
async function createPackageWithResource(name: string, orgId: string) {
  const pkgRes = await app.request('/api/v1/packages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `pkg-${name}`,
      title: `Package ${name}`,
      owner_org: orgId,
    }),
  })
  const pkg = await pkgRes.json()

  await app.request(`/api/v1/packages/${pkg.id}/resources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `resource-${name}`,
      url: `https://example.com/${name}.csv`,
      format: 'CSV',
    }),
  })

  return pkg
}

describe('Admin API Routes', () => {
  describe('POST /api/v1/admin/reindex', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await unauthApp.request('/api/v1/admin/reindex', { method: 'POST' })
      expect(res.status).toBe(403)
    })

    it('should reject non-sysadmin requests', async () => {
      const res = await nonAdminApp.request('/api/v1/admin/reindex', { method: 'POST' })
      expect(res.status).toBe(403)
    })

    it('should return 0 indexed when no packages exist', async () => {
      const res = await app.request('/api/v1/admin/reindex', { method: 'POST' })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.indexed).toBe(0)
      expect(mockSearch.bulkIndexPackages).not.toHaveBeenCalled()
    })

    it('should reindex all active packages', async () => {
      const orgId = await ensureOrg('test-org')
      await createPackageWithResource('alpha', orgId)
      await createPackageWithResource('beta', orgId)

      const res = await app.request('/api/v1/admin/reindex', { method: 'POST' })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.indexed).toBe(2)
      expect(mockSearch.bulkIndexPackages).toHaveBeenCalledOnce()

      const docs = vi.mocked(mockSearch.bulkIndexPackages).mock.calls[0][0]
      expect(docs).toHaveLength(2)

      const names = docs.map((d) => d.name).sort()
      expect(names).toEqual(['pkg-alpha', 'pkg-beta'])

      // Dataset docs should NOT contain resources (moved to kukan-resources)
      for (const doc of docs) {
        expect(doc['resources']).toBeUndefined()
        expect(doc.organization).toBe('test-org')
        expect(doc.formats).toEqual(['CSV'])
        expect(doc.tags).toEqual([])
        expect(doc.groups).toEqual([])
      }

      // Resources should be indexed separately
      expect(body.resourcesIndexed).toBe(2)
    })
  })
})
