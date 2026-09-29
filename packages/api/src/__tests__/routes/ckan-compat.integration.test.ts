import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createTestApp, mockSearch } from '../test-helpers/test-app'
import {
  getTestDb,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  ensureOutsiderUser,
  OUTSIDER_USER_ID,
} from '../test-helpers/test-db'
import { PostgresSearchAdapter } from '@kukan/search-adapter'
import { findLicense } from '@kukan/shared'

const db = getTestDb()
const search = new PostgresSearchAdapter(db)
const app = createTestApp(db, { search })
const unauthApp = createTestApp(db, { search, user: null })
const outsiderApp = createTestApp(db, {
  search,
  user: {
    id: '00000000-0000-0000-0000-000000000099',
    email: 'outsider@example.com',
    name: 'outsider',
    sysadmin: false,
  },
})

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
    body: JSON.stringify({ name, ownerOrg: orgId, ...extra }),
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

    it('serves each result whole, as package_show does', async () => {
      const pkg = await createPackage('search-license', {
        title: 'Search license',
        licenseId: 'ODbL-1.0',
        tags: [{ name: 'traffic' }],
      })
      await app.request(`/api/v1/packages/${pkg.id}/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'counts', format: 'CSV' }),
      })

      const res = await app.request('/api/3/action/package_search?q=search-license')
      const body = await res.json()

      expect(body.result.count).toBe(1)
      const [result] = body.result.results
      expect(result).toMatchObject({
        id: pkg.id,
        name: 'search-license',
        license_id: 'ODbL-1.0',
        license_title: findLicense('ODbL-1.0')!.title,
        owner_org: testOrgId,
        creator_user_id: pkg.creatorUserId,
        metadata_created: expect.any(String),
        metadata_modified: expect.any(String),
        tags: [expect.objectContaining({ name: 'traffic' })],
        organization: expect.objectContaining({ name: 'test-org-ckan' }),
        resources: [expect.objectContaining({ name: 'counts', package_id: pkg.id })],
      })
      // What the search adapter adds for the web cards stays out of CKAN's shape
      expect(result).not.toHaveProperty('matchedResources')
      expect(result).not.toHaveProperty('highlightedTitle')

      const show = await app.request(`/api/3/action/package_show?id=${pkg.id}`)
      expect(result).toEqual((await show.json()).result)
    })

    it('keeps the order the search chose, and checks visibility again in the database', async () => {
      const first = await createPackage('search-first')
      const second = await createPackage('search-second')
      // Private since the index last saw it: the search still answers its id
      const hidden = await createPackage('search-hidden', { private: true })
      const ids = [second.id, hidden.id, '00000000-0000-0000-0000-00000000dead', first.id]
      const staleIndex = createTestApp(db, {
        user: null,
        search: {
          ...mockSearch,
          search: async () => ({
            items: ids.map((id) => ({ id, name: '' })),
            total: ids.length,
            offset: 0,
            limit: 20,
          }),
        },
      })

      const res = await staleIndex.request('/api/3/action/package_search?q=search')
      const body = await res.json()

      expect(body.result.results.map((r: { name: string }) => r.name)).toEqual([
        'search-second',
        'search-first',
      ])
    })

    it('pages by the index while it lags, so paging on to the count misses nothing', async () => {
      const shown = await createPackage('search-shown')
      const hidden = await createPackage('search-hidden', { private: true })
      // The index still ranks the now-private dataset first, of two in all
      const ranked = [hidden.id, shown.id]
      const staleIndex = createTestApp(db, {
        user: null,
        search: {
          ...mockSearch,
          search: async ({ offset = 0, limit = 20 }) => ({
            items: ranked.slice(offset, offset + limit).map((id) => ({ id, name: '' })),
            total: ranked.length,
            offset,
            limit,
          }),
        },
      })
      const page = async (start: number) =>
        (
          await (
            await staleIndex.request(`/api/3/action/package_search?q=search&rows=1&start=${start}`)
          ).json()
        ).result

      const first = await page(0)
      expect(first.results).toEqual([])
      expect(first.count).toBe(2)
      const seen: string[] = []
      for (let start = 0; start < first.count; start++) {
        const { count, results } = await page(start)
        expect(count).toBe(first.count)
        seen.push(...results.map((r: { name: string }) => r.name))
      }
      expect(seen).toEqual(['search-shown'])
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
      // The CKAN contract is a flat resource — internal ownership stays out of it
      expect(body.result).not.toHaveProperty('pkg')
    })

    it('should return 404 for non-existent resource', async () => {
      const res = await app.request(
        '/api/3/action/resource_show?id=00000000-0000-0000-0000-000000000000'
      )
      expect(res.status).toBe(404)

      const body = await res.json()
      expect(body.success).toBe(false)
    })

    it('should return 404 for private package resource when unauthenticated', async () => {
      const pkg = await createPackage('private-ckan-res', { private: true })

      const createRes = await app.request(`/api/v1/packages/${pkg.id}/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'secret-resource', format: 'CSV' }),
      })
      const resource = await createRes.json()

      const res = await unauthApp.request(`/api/3/action/resource_show?id=${resource.id}`)
      expect(res.status).toBe(404)

      const body = await res.json()
      expect(body.success).toBe(false)
    })

    it('should return 404 for private package resource when user is not org member', async () => {
      const pkg = await createPackage('private-ckan-res2', { private: true })

      const createRes = await app.request(`/api/v1/packages/${pkg.id}/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'secret-resource-2', format: 'CSV' }),
      })
      const resource = await createRes.json()

      const res = await outsiderApp.request(`/api/3/action/resource_show?id=${resource.id}`)
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

    // Pins the c.get('user') wiring on this route: the caller's visibility
    // decides which tags surface, same rule as GET /api/v1/tags
    it('should scope tags to the caller visibility', async () => {
      await ensureOutsiderUser()
      await createPackage('ckan-vis-pub', { tags: [{ name: 'ckan-pub-tag' }] })
      await createPackage('ckan-vis-priv', { private: true, tags: [{ name: 'ckan-priv-tag' }] })
      await app.request('/api/v1/organizations/test-org-ckan/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: OUTSIDER_USER_ID, role: 'member' }),
      })

      const anon = (await (await unauthApp.request('/api/3/action/tag_list')).json()).result
      expect(anon).toEqual(['ckan-pub-tag'])

      const member = (await (await outsiderApp.request('/api/3/action/tag_list')).json())
        .result as string[]
      expect(member.sort()).toEqual(['ckan-priv-tag', 'ckan-pub-tag'])
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

    it('should hide a private-only tag from anonymous callers', async () => {
      await ensureOutsiderUser()
      await createPackage('ckan-show-priv', {
        private: true,
        tags: [{ name: 'ckan-show-priv-tag' }],
      })
      await app.request('/api/v1/organizations/test-org-ckan/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: OUTSIDER_USER_ID, role: 'member' }),
      })
      const { items } = await (await app.request('/api/v1/tags')).json()
      const tagId = items[0].id

      expect((await unauthApp.request(`/api/3/action/tag_show?id=${tagId}`)).status).toBe(404)
      expect((await outsiderApp.request(`/api/3/action/tag_show?id=${tagId}`)).status).toBe(200)
    })
  })
})
