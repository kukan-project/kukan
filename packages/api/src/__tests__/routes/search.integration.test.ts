import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createTestApp } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'
import { PostgresSearchAdapter } from '@kukan/search-adapter'

const db = getTestDb()
const searchAdapter = new PostgresSearchAdapter(db)
const app = createTestApp(db, { search: searchAdapter })

let testOrgId: string

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
  testOrgId = undefined as unknown as string
})

afterAll(async () => {
  await closeTestDb()
})

// Helper: create an organization via API
async function createOrg(name: string) {
  const res = await app.request('/api/v1/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  return res
}

async function ensureTestOrg() {
  if (testOrgId) return testOrgId
  const res = await createOrg('test-org-search')
  const org = await res.json()
  testOrgId = org.id
  return testOrgId
}

// Helper: create a package via API (auto-injects owner_org)
async function createPackage(data: Record<string, unknown>) {
  const orgId = data.owner_org || (await ensureTestOrg())
  return app.request('/api/v1/packages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner_org: orgId, ...data }),
  })
}

describe('Search API Routes', () => {
  describe('GET /api/v1/search - validation', () => {
    it('should return 400 when q is missing', async () => {
      const res = await app.request('/api/v1/search')
      expect(res.status).toBe(400)

      const body = await res.json()
      expect(body.detail).toContain('q')
    })

    it('should return 400 when q is empty', async () => {
      const res = await app.request('/api/v1/search?q=')
      expect(res.status).toBe(400)
    })

    it('should return 400 for invalid offset', async () => {
      const res = await app.request('/api/v1/search?q=test&offset=-1')
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.detail).toContain('offset')
    })

    it('should return 400 for invalid limit', async () => {
      const res = await app.request('/api/v1/search?q=test&limit=0')
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.detail).toContain('limit')
    })

    it('should return 400 for limit exceeding 100', async () => {
      const res = await app.request('/api/v1/search?q=test&limit=101')
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/v1/search - full-text search', () => {
    it('should return empty results when no packages match', async () => {
      const res = await app.request('/api/v1/search?q=nonexistent')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.items).toEqual([])
      expect(body.total).toBe(0)
    })

    it('should find packages by name', async () => {
      await createPackage({ name: 'population-stats' })
      await createPackage({ name: 'weather-data' })

      const res = await app.request('/api/v1/search?q=population')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0].name).toBe('population-stats')
    })

    it('should find packages by title', async () => {
      await createPackage({ name: 'dataset-a', title: 'Tokyo Population Census' })
      await createPackage({ name: 'dataset-b', title: 'Weather Forecast' })

      const res = await app.request('/api/v1/search?q=Census')
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0].name).toBe('dataset-a')
    })

    it('should find packages by notes', async () => {
      await createPackage({ name: 'noted-pkg', notes: 'Contains demographic statistics' })

      const res = await app.request('/api/v1/search?q=demographic')
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0].name).toBe('noted-pkg')
    })

    it('should only return active packages', async () => {
      const createRes = await createPackage({ name: 'to-delete' })
      const created = await createRes.json()

      // Delete the package (sets state=deleted)
      await app.request(`/api/v1/packages/${created.id}`, { method: 'DELETE' })

      const res = await app.request('/api/v1/search?q=to-delete')
      const body = await res.json()
      expect(body.total).toBe(0)
    })

    it('should include tags in results', async () => {
      await createPackage({
        name: 'tagged-dataset',
        tags: [{ name: 'open-data' }, { name: 'statistics' }],
      })

      const res = await app.request('/api/v1/search?q=tagged')
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0].tags).toEqual(expect.arrayContaining(['open-data', 'statistics']))
    })

    it('should paginate results', async () => {
      // Create 5 packages with searchable name
      for (let i = 0; i < 5; i++) {
        await createPackage({ name: `searchable-pkg-${i}` })
      }

      const res = await app.request('/api/v1/search?q=searchable&offset=2&limit=2')
      const body = await res.json()
      expect(body.total).toBe(5)
      expect(body.items).toHaveLength(2)
      expect(body.offset).toBe(2)
      expect(body.limit).toBe(2)
    })
  })

  describe('GET /api/v1/search - filters', () => {
    it('should filter by organization', async () => {
      const orgRes = await createOrg('test-city')
      const org = await orgRes.json()

      await createPackage({ name: 'city-data', owner_org: org.id })
      await createPackage({ name: 'other-data' })

      // Both match "data" but only one belongs to test-city
      const res = await app.request('/api/v1/search?q=data&organization=test-city')
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0].name).toBe('city-data')
      expect(body.items[0].organization).toBe('test-city')
    })

    it('should filter by tags', async () => {
      await createPackage({
        name: 'env-dataset',
        title: 'Environment Data',
        tags: [{ name: 'environment' }],
      })
      await createPackage({
        name: 'pop-dataset',
        title: 'Population Data',
        tags: [{ name: 'population' }],
      })

      const res = await app.request('/api/v1/search?q=Data&tags=environment')
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0].name).toBe('env-dataset')
    })
  })
})
