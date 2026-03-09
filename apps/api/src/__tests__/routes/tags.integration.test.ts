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
    body: JSON.stringify({ name: 'test-org-tags' }),
  })
  const org = await res.json()
  testOrgId = org.id
  return testOrgId
}

describe('Tags API Routes', () => {
  // Helper: create a package with tags to populate the tag table
  async function createPackageWithTags(name: string, tags: string[]) {
    const orgId = await ensureTestOrg()
    return app.request('/api/v1/packages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, owner_org: orgId, tags: tags.map((t) => ({ name: t })) }),
    })
  }

  describe('GET /api/v1/tags', () => {
    it('should return empty tag list', async () => {
      const res = await app.request('/api/v1/tags')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.items).toEqual([])
      expect(body.total).toBe(0)
    })

    it('should return tags created via packages', async () => {
      await createPackageWithTags('tagged-pkg', ['open-data', 'statistics'])

      const res = await app.request('/api/v1/tags')
      const body = await res.json()
      expect(body.total).toBe(2)

      const names = body.items.map((t: { name: string }) => t.name).sort()
      expect(names).toEqual(['open-data', 'statistics'])
    })

    it('should filter by q parameter', async () => {
      await createPackageWithTags('filter-test', ['population', 'weather', 'environment'])

      const res = await app.request('/api/v1/tags?q=pop')
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0].name).toBe('population')
    })
  })

  describe('GET /api/v1/tags/:id', () => {
    it('should return 404 for non-existent tag', async () => {
      const res = await app.request('/api/v1/tags/00000000-0000-0000-0000-000000000000')
      expect(res.status).toBe(404)
    })

    it('should return tag with package count', async () => {
      await createPackageWithTags('pkg-a', ['shared-tag'])
      await createPackageWithTags('pkg-b', ['shared-tag'])

      // Get tag ID from list
      const listRes = await app.request('/api/v1/tags')
      const listBody = await listRes.json()
      const tagId = listBody.items[0].id

      const res = await app.request(`/api/v1/tags/${tagId}`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.name).toBe('shared-tag')
      expect(body.packageCount).toBe(2)
    })
  })
})
