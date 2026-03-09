import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createTestApp } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'

const db = getTestDb()
const app = createTestApp(db)

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
  testOrgId = undefined as unknown as string
})

afterAll(async () => {
  await closeTestDb()
})

// Helper: create entities via v1 API
let testOrgId: string

async function ensureTestOrg() {
  if (testOrgId) return testOrgId
  const org = await createOrganization('test-org-ckan')
  testOrgId = org.id
  return testOrgId
}

async function createPackage(name: string, extra?: Record<string, unknown>) {
  const orgId = await ensureTestOrg()
  const res = await app.request('/api/v1/packages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, owner_org: orgId, ...extra }),
  })
  return res.json()
}

async function createOrganization(name: string, title?: string) {
  const res = await app.request('/api/v1/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, title }),
  })
  return res.json()
}

async function createGroup(name: string, title?: string) {
  const res = await app.request('/api/v1/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, title }),
  })
  return res.json()
}

describe('CKAN-Compatible API (/api/3/action)', () => {
  // ============================================================
  // Package Actions
  // ============================================================
  describe('package_list', () => {
    it('should return empty list', async () => {
      const res = await app.request('/api/3/action/package_list')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.result).toEqual([])
      expect(body.help).toContain('package_list')
    })

    it('should return package names', async () => {
      await createPackage('ckan-pkg-one')
      await createPackage('ckan-pkg-two')

      const res = await app.request('/api/3/action/package_list')
      const body = await res.json()
      expect(body.success).toBe(true)

      const names = (body.result as string[]).sort()
      expect(names).toEqual(['ckan-pkg-one', 'ckan-pkg-two'])
    })
  })

  describe('package_show', () => {
    it('should return error when id is missing', async () => {
      const res = await app.request('/api/3/action/package_show')
      expect(res.status).toBe(400)

      const body = await res.json()
      expect(body.success).toBe(false)
      expect(body.error.message).toContain('Missing parameter')
    })

    it('should return package by name', async () => {
      await createPackage('ckan-show-test', { title: 'CKAN Show' })

      const res = await app.request('/api/3/action/package_show?id=ckan-show-test')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.result.name).toBe('ckan-show-test')
      expect(body.result.title).toBe('CKAN Show')
    })

    it('should return 404 for non-existent package', async () => {
      const res = await app.request('/api/3/action/package_show?id=no-such-pkg')
      expect(res.status).toBe(404)

      const body = await res.json()
      expect(body.success).toBe(false)
    })
  })

  describe('package_search', () => {
    it('should return search results (mock adapter)', async () => {
      const res = await app.request('/api/3/action/package_search?q=test')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.result.count).toBe(0)
      expect(body.result.results).toEqual([])
    })
  })

  // ============================================================
  // Resource Actions
  // ============================================================
  describe('resource_show', () => {
    it('should return error when id is missing', async () => {
      const res = await app.request('/api/3/action/resource_show')
      expect(res.status).toBe(400)

      const body = await res.json()
      expect(body.success).toBe(false)
    })

    it('should return resource by id', async () => {
      const pkg = await createPackage('res-ckan-test')

      const createRes = await app.request(`/api/v1/packages/${pkg.id}/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'ckan-resource', format: 'CSV' }),
      })
      const resource = await createRes.json()

      const res = await app.request(`/api/3/action/resource_show?id=${resource.id}`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.result.name).toBe('ckan-resource')
    })

    it('should return 404 for non-existent resource', async () => {
      const res = await app.request(
        '/api/3/action/resource_show?id=00000000-0000-0000-0000-000000000000'
      )
      expect(res.status).toBe(404)

      const body = await res.json()
      expect(body.success).toBe(false)
    })
  })

  // ============================================================
  // Organization Actions
  // ============================================================
  describe('organization_list', () => {
    it('should return empty list', async () => {
      const res = await app.request('/api/3/action/organization_list')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.result).toEqual([])
    })

    it('should return organization names', async () => {
      await createOrganization('ckan-org-a')
      await createOrganization('ckan-org-b')

      const res = await app.request('/api/3/action/organization_list')
      const body = await res.json()

      const names = (body.result as string[]).sort()
      expect(names).toEqual(['ckan-org-a', 'ckan-org-b'])
    })
  })

  describe('organization_show', () => {
    it('should return error when id is missing', async () => {
      const res = await app.request('/api/3/action/organization_show')
      expect(res.status).toBe(400)

      const body = await res.json()
      expect(body.success).toBe(false)
    })

    it('should return organization by name', async () => {
      await createOrganization('ckan-org-show', 'CKAN Org')

      const res = await app.request('/api/3/action/organization_show?id=ckan-org-show')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.result.name).toBe('ckan-org-show')
    })

    it('should return 404 for non-existent organization', async () => {
      const res = await app.request('/api/3/action/organization_show?id=no-such-org')
      expect(res.status).toBe(404)

      const body = await res.json()
      expect(body.success).toBe(false)
    })
  })

  // ============================================================
  // Group Actions
  // ============================================================
  describe('group_list', () => {
    it('should return group names', async () => {
      await createGroup('ckan-grp-a')
      await createGroup('ckan-grp-b')

      const res = await app.request('/api/3/action/group_list')
      const body = await res.json()
      expect(body.success).toBe(true)

      const names = (body.result as string[]).sort()
      expect(names).toEqual(['ckan-grp-a', 'ckan-grp-b'])
    })
  })

  describe('group_show', () => {
    it('should return error when id is missing', async () => {
      const res = await app.request('/api/3/action/group_show')
      expect(res.status).toBe(400)
    })

    it('should return group by name', async () => {
      await createGroup('ckan-grp-show', 'CKAN Group')

      const res = await app.request('/api/3/action/group_show?id=ckan-grp-show')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.result.name).toBe('ckan-grp-show')
    })

    it('should return 404 for non-existent group', async () => {
      const res = await app.request('/api/3/action/group_show?id=no-such-grp')
      expect(res.status).toBe(404)
    })
  })

  // ============================================================
  // Tag Actions
  // ============================================================
  describe('tag_list', () => {
    it('should return tag names', async () => {
      await createPackage('tag-ckan-test', {
        tags: [{ name: 'ckan-tag-a' }, { name: 'ckan-tag-b' }],
      })

      const res = await app.request('/api/3/action/tag_list')
      const body = await res.json()
      expect(body.success).toBe(true)

      const names = (body.result as string[]).sort()
      expect(names).toEqual(['ckan-tag-a', 'ckan-tag-b'])
    })
  })

  describe('tag_show', () => {
    it('should return error when id is missing', async () => {
      const res = await app.request('/api/3/action/tag_show')
      expect(res.status).toBe(400)
    })

    it('should return tag by id', async () => {
      await createPackage('tag-show-ckan', { tags: [{ name: 'ckan-tag-show' }] })

      // Get tag ID from v1 API
      const listRes = await app.request('/api/v1/tags')
      const listBody = await listRes.json()
      const tagId = listBody.items[0].id

      const res = await app.request(`/api/3/action/tag_show?id=${tagId}`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.result.name).toBe('ckan-tag-show')
    })

    it('should return 404 for non-existent tag', async () => {
      const res = await app.request(
        '/api/3/action/tag_show?id=00000000-0000-0000-0000-000000000000'
      )
      expect(res.status).toBe(404)
    })
  })
})
