import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createTestApp, rankingSearch } from '../test-helpers/test-app'
import {
  getTestDb,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  ensureOutsiderUser,
  OUTSIDER_USER_ID,
} from '../test-helpers/test-db'
import { eq } from 'drizzle-orm'
import { PostgresSearchAdapter } from '@kukan/search-adapter'
import { packageTable } from '@kukan/db'
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

    it('does not name a dataset the index still ranks after it was made private', async () => {
      const shown = await createPackage('list-shown')
      const hidden = await createPackage('list-hidden', { private: true })
      const ranked = [hidden.id, shown.id]
      const staleIndex = createTestApp(db, {
        user: null,
        search: rankingSearch(ranked),
      })

      const body = await (await staleIndex.request('/api/3/action/package_list')).json()
      expect(body.result).toEqual(['list-shown'])
    })
  })

  describe('package_show', () => {
    it('should return error when id is missing', async () => {
      const res = await app.request('/api/3/action/package_show')
      expect(res.status).toBe(409)

      const body = await res.json()
      expect(body.success).toBe(false)
      expect(body.error).toEqual({ id: ['Missing value'], __type: 'Validation Error' })
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
        search: rankingSearch(ids),
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
        search: rankingSearch(ranked),
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
      expect(res.status).toBe(409)

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
      expect(res.status).toBe(409)

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
      expect(res.status).toBe(409)
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
      expect(res.status).toBe(409)
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

  // ============================================================
  // As CKAN 2.12 serves it
  // ============================================================
  describe('CKAN 2.12 shapes', () => {
    async function createResource(packageId: string, body: Record<string, unknown>) {
      const res = await app.request(`/api/v1/packages/${packageId}/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(201)
      return res.json()
    }

    it('serves a dataset with CKAN field names and nothing of KUKAN own', async () => {
      const grp = await createGroup('shape-grp', 'Shape group')
      const pkg = await createPackage('shape-pkg', {
        title: 'Shape',
        authorEmail: 'author@example.com',
        maintainerEmail: 'keeper@example.com',
        licenseId: 'CC-BY-4.0',
        extras: { theme: 'traffic', year: 2024 },
        tags: [{ name: 'shape-tag' }],
        groups: [{ name: grp.name }],
      })
      await createResource(pkg.id, { name: 'r', url: 'https://example.com/a.csv' })

      const body = await (await app.request('/api/3/action/package_show?id=shape-pkg')).json()
      const result = body.result
      expect(Object.keys(result).sort()).toEqual(
        [
          'author',
          'author_email',
          'creator_user_id',
          'extras',
          'groups',
          'id',
          'isopen',
          'license_id',
          'license_title',
          'license_url',
          'maintainer',
          'maintainer_email',
          'metadata_created',
          'metadata_modified',
          'name',
          'notes',
          'num_resources',
          'num_tags',
          'organization',
          'owner_org',
          'private',
          'relationships_as_object',
          'relationships_as_subject',
          'resources',
          'state',
          'tags',
          'title',
          'type',
          'url',
          'version',
        ].sort()
      )
      expect(result).toMatchObject({
        author_email: 'author@example.com',
        maintainer_email: 'keeper@example.com',
        isopen: true,
        num_resources: 1,
        num_tags: 1,
        tags: [
          { name: 'shape-tag', display_name: 'shape-tag', state: 'active', vocabulary_id: null },
        ],
        groups: [
          expect.objectContaining({
            name: 'shape-grp',
            display_name: 'Shape group',
            is_organization: false,
            type: 'group',
          }),
        ],
        organization: expect.objectContaining({
          name: 'test-org-ckan',
          is_organization: true,
          type: 'organization',
          approval_status: 'approved',
          image_url: null,
        }),
      })
      // Values are strings in CKAN; others arrive as their JSON text. jsonb keeps no key order
      expect(result.extras).toHaveLength(2)
      expect(result.extras).toEqual(
        expect.arrayContaining([
          { key: 'theme', value: 'traffic' },
          { key: 'year', value: '2024' },
        ])
      )
      // UTC without an offset, to the microsecond
      expect(result.metadata_created).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}$/)
    })

    it('spreads a resource extras onto its top level and keeps the pipeline bookkeeping out', async () => {
      const pkg = await createPackage('shape-res')
      const link = await createResource(pkg.id, {
        name: 'link',
        url: 'https://example.com/b.csv',
        section: 'Annual',
        extras: { unit: 'persons' },
      })
      const upload = await createResource(pkg.id, { name: 'file.csv', urlType: 'upload' })

      const shown = (await (await app.request(`/api/3/action/resource_show?id=${link.id}`)).json())
        .result
      expect(shown).toMatchObject({
        id: link.id,
        package_id: pkg.id,
        url: 'https://example.com/b.csv',
        url_type: null,
        unit: 'persons',
        section: 'Annual',
        mimetype_inner: null,
        cache_url: null,
      })
      for (const key of [
        'extras',
        'urlType',
        'packageId',
        'contentRevision',
        'pendingStorageKeyAt',
        'pipelineStatus',
        'latestVersion',
        'columnSettings',
        'healthStatus',
        'healthCheckedAt',
        'qualityIssues',
        'summary',
      ]) {
        expect(shown).not.toHaveProperty(key)
      }

      const file = (await (await app.request(`/api/3/action/resource_show?id=${upload.id}`)).json())
        .result
      // A file name alone leaves a CKAN client nothing to download
      expect(file.url).toBe(`http://localhost:3000/api/v1/resources/${upload.id}/download`)
      expect(file.url_type).toBe('upload')
    })

    it('serves an organization with its extras as pairs and its members left out', async () => {
      await ensureTestOrg()
      await app.request('/api/v1/organizations/test-org-ckan', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test-org-ckan',
          title: 'Test org',
          extras: { pref: 'Aomori' },
        }),
      })
      await createPackage('org-count-a')
      await createPackage('org-count-b', { private: true })

      const anon = (
        await (await unauthApp.request('/api/3/action/organization_show?id=test-org-ckan')).json()
      ).result
      expect(anon).toMatchObject({
        name: 'test-org-ckan',
        display_name: 'Test org',
        is_organization: true,
        package_count: 1,
        extras: [{ key: 'pref', value: 'Aomori' }],
      })
      expect(anon).not.toHaveProperty('users')
      expect(anon).not.toHaveProperty('packages')

      const withDatasets = (
        await (
          await app.request(
            '/api/3/action/organization_show?id=test-org-ckan&include_datasets=true'
          )
        ).json()
      ).result
      expect(withDatasets.package_count).toBe(2)
      expect(withDatasets.packages.map((p: { name: string }) => p.name).sort()).toEqual([
        'org-count-a',
        'org-count-b',
      ])
    })

    it('lists organizations by title, whole with all_fields', async () => {
      await createOrganization('org-z', 'Alpha')
      await createOrganization('org-a', 'Beta')

      const names = (await (await app.request('/api/3/action/organization_list')).json()).result
      expect(names).toEqual(['org-z', 'org-a'])
      const byName = (
        await (await app.request('/api/3/action/organization_list?sort=name%20asc')).json()
      ).result
      expect(byName).toEqual(['org-a', 'org-z'])

      const full = (
        await (await app.request('/api/3/action/organization_list?all_fields=true&limit=1')).json()
      ).result
      expect(full).toEqual([
        expect.objectContaining({ name: 'org-z', display_name: 'Alpha', package_count: 0 }),
      ])

      testOrgId = (await createOrganization('org-busy', 'Gamma')).id
      await createPackage('busy-one')
      const busiest = (
        await (
          await app.request('/api/3/action/organization_list?sort=package_count%20desc&limit=1')
        ).json()
      ).result
      expect(busiest).toEqual(['org-busy'])
      // Bare, and by its older name, a count sort is busiest first as in CKAN
      for (const sort of ['package_count', 'packages']) {
        const bare = (
          await (await app.request(`/api/3/action/organization_list?sort=${sort}&limit=1`)).json()
        ).result
        expect(bare, sort).toEqual(['org-busy'])
      }

      const named = (
        await (
          await app.request(
            '/api/3/action/organization_list?organizations=org-a&organizations=org-busy'
          )
        ).json()
      ).result
      expect(named).toEqual(['org-a', 'org-busy'])
      // One string is read as CKAN's aslist reads it
      const commas = (
        await (
          await app.request('/api/3/action/organization_list?organizations=org-a,org-busy')
        ).json()
      ).result
      expect(commas).toEqual(['org-a', 'org-busy'])
    })

    it('reads a tag by name, and lists tags whole with all_fields', async () => {
      await createPackage('tag-name-pkg', { tags: [{ name: 'by-name' }] })

      const shown = await (await app.request('/api/3/action/tag_show?id=by-name')).json()
      expect(shown.result).toMatchObject({ name: 'by-name', display_name: 'by-name' })

      const listed = (await (await app.request('/api/3/action/tag_list?all_fields=true')).json())
        .result
      expect(listed).toEqual([expect.objectContaining({ name: 'by-name', vocabulary_id: null })])

      await createPackage('tag-other-pkg', { tags: [{ name: 'unrelated' }] })
      for (const key of ['query', 'q']) {
        const found = (await (await app.request(`/api/3/action/tag_list?${key}=by-`)).json()).result
        expect(found, key).toEqual(['by-name'])
      }
    })

    it('answers a POST, JSON or form, at the unversioned path ckanapi calls', async () => {
      await createPackage('posted')

      const json = await app.request('/api/action/package_show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'posted' }),
      })
      expect(json.status).toBe(200)
      expect((await json.json()).result.name).toBe('posted')

      const form = await app.request('/api/3/action/package_show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'id=posted',
      })
      expect((await form.json()).result.name).toBe('posted')

      // A lone value of 1 is a value, not the old clients' JSON-as-key form
      const one = await app.request('/api/3/action/package_list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'limit=1',
      })
      expect((await one.json()).result).toEqual(['posted'])
      const legacy = await app.request('/api/3/action/package_show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `${encodeURIComponent('{"id":"posted"}')}=1`,
      })
      expect((await legacy.json()).result.name).toBe('posted')
    })

    it('counts and lists a group and a tag under the caller visibility', async () => {
      await ensureOutsiderUser()
      await createGroup('vis-grp')
      await createPackage('vis-public', { groups: [{ name: 'vis-grp' }], tags: [{ name: 'vis' }] })
      await createPackage('vis-private', {
        private: true,
        groups: [{ name: 'vis-grp' }],
        tags: [{ name: 'vis' }],
      })
      await app.request('/api/v1/organizations/test-org-ckan/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: OUTSIDER_USER_ID, role: 'member' }),
      })
      const names = (r: { packages: { name: string }[] }) => r.packages.map((p) => p.name).sort()
      const show = async (from: typeof app, path: string) =>
        (await (await from.request(`/api/3/action/${path}`)).json()).result

      const member = await show(outsiderApp, 'group_show?id=vis-grp&include_datasets=true')
      expect(member.package_count).toBe(2)
      expect(names(member)).toEqual(['vis-private', 'vis-public'])
      const anon = await show(unauthApp, 'group_show?id=vis-grp&include_datasets=true')
      expect(anon.package_count).toBe(1)

      const tag = await show(outsiderApp, 'tag_show?id=vis&include_datasets=true')
      expect(names(tag)).toEqual(['vis-private', 'vis-public'])
      expect(names(await show(unauthApp, 'tag_show?id=vis&include_datasets=true'))).toEqual([
        'vis-public',
      ])
    })

    it('lists up to 1000 of a group datasets and 10 of an organization', async () => {
      await createGroup('big-grp')
      for (let i = 0; i < 11; i++) {
        await createPackage(`big-${String(i).padStart(2, '0')}`, { groups: [{ name: 'big-grp' }] })
      }
      const group = (
        await (
          await app.request('/api/3/action/group_show?id=big-grp&include_datasets=true')
        ).json()
      ).result
      expect(group.packages).toHaveLength(11)
      const org = (
        await (
          await app.request(
            '/api/3/action/organization_show?id=test-org-ckan&include_datasets=true'
          )
        ).json()
      ).result
      expect(org.package_count).toBe(11)
      expect(org.packages).toHaveLength(10)
    })

    it('bounds a POST body and takes no multipart', async () => {
      const big = await app.request('/api/3/action/package_show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'x', pad: 'x'.repeat(2 * 1024 * 1024) }),
      })
      expect(big.status).toBe(413)

      const form = new FormData()
      form.append('id', 'x')
      const multipart = await app.request('/api/3/action/package_show', {
        method: 'POST',
        body: form,
      })
      expect(multipart.status).toBe(400)
    })

    it('fails as CKAN does', async () => {
      const unknown = await app.request('/api/3/action/package_create', { method: 'POST' })
      expect(unknown.status).toBe(400)
      expect(await unknown.json()).toBe('Bad request: Action name not known: package_create')

      const missing = await app.request('/api/3/action/package_show?id=nope')
      expect(missing.status).toBe(404)
      const body = await missing.json()
      expect(body.error.__type).toBe('Not Found Error')
      expect(body.help).toBe('http://localhost:3000/api/3/action/help_show?name=package_show')

      const help = await app.request(body.help)
      expect((await help.json()).result).toContain('package_show')
      expect((await app.request('/api/3/action/help_show?name=package_create')).status).toBe(404)

      const badJson = await app.request('/api/3/action/package_show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      })
      expect(badJson.status).toBe(400)
    })
  })

  describe('package_search as CKAN reads it', () => {
    const search = async (query: string, from = app) =>
      (await (await from.request(`/api/3/action/package_search?${query}`)).json()).result

    it('leaves private datasets out unless include_private is set', async () => {
      await createPackage('ps-public')
      await createPackage('ps-private', { private: true })

      expect((await search('q=ps')).results.map((r: { name: string }) => r.name)).toEqual([
        'ps-public',
      ])
      const withPrivate = await search('q=ps&include_private=true&sort=name%20asc')
      expect(withPrivate.results.map((r: { name: string }) => r.name)).toEqual([
        'ps-private',
        'ps-public',
      ])
    })

    it('reads search hits back public only unless include_private is set', async () => {
      // The index still ranks a dataset made private since; the database is what keeps it out
      const shown = await createPackage('lag-public')
      const hidden = await createPackage('lag-private', { private: true })
      const staleIndex = createTestApp(db, { search: rankingSearch([hidden.id, shown.id]) })
      const names = async (query: string) =>
        (
          await (await staleIndex.request(`/api/3/action/package_search?${query}`)).json()
        ).result.results.map((r: { name: string }) => r.name)

      expect(await names('q=lag')).toEqual(['lag-public'])
      expect(await names('q=lag&include_private=true')).toEqual(['lag-private', 'lag-public'])
    })

    it('filters on fq, as the CKAN harvester sends it', async () => {
      const old = await createPackage('fq-old', { tags: [{ name: 'a' }] })
      await createPackage('fq-new', { tags: [{ name: 'a' }, { name: 'b' }] })
      await db
        .update(packageTable)
        .set({ updated: new Date('2020-01-01T00:00:00Z') })
        .where(eq(packageTable.id, old.id))

      const since = await search(
        `fq=${encodeURIComponent('metadata_modified:[2021-01-01T00:00:00.000000Z TO *]')}`
      )
      expect(since.results.map((r: { name: string }) => r.name)).toEqual(['fq-new'])

      const tagged = await search(`fq=${encodeURIComponent('+tags:a +tags:"b"')}`)
      expect(tagged.results.map((r: { name: string }) => r.name)).toEqual(['fq-new'])
      const listed = await search(`fq_list=${encodeURIComponent('["tags:a","tags:b"]')}`)
      expect(listed.results.map((r: { name: string }) => r.name)).toEqual(['fq-new'])

      const org = await search(
        `fq=${encodeURIComponent('organization:test-org-ckan')}&sort=id%20asc&rows=100`
      )
      expect(org.count).toBe(2)
      const ids = org.results.map((r: { id: string }) => r.id)
      expect(ids).toEqual([...ids].sort())

      // One format in two spellings is one format
      const pkg = await createPackage('fq-format')
      await app.request(`/api/v1/packages/${pkg.id}/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'f', url: 'https://example.com/f.csv', format: 'CSV' }),
      })
      const formats = await search(`fq=${encodeURIComponent('res_format:CSV res_format:csv')}`)
      expect(formats.results.map((r: { name: string }) => r.name)).toEqual(['fq-format'])

      const otherOrg = await search(`fq=${encodeURIComponent('organization:other')}`)
      expect(otherOrg.count).toBe(0)
    })

    it('refuses what it cannot answer rather than returning more', async () => {
      for (const query of [
        `fq=${encodeURIComponent('tags:a OR tags:b')}`,
        `fq=${encodeURIComponent('-tags:a')}`,
        `fq=${encodeURIComponent('notes:x')}`,
        'sort=title_string%20asc',
        `facet.field=${encodeURIComponent('["author"]')}`,
      ]) {
        const res = await app.request(`/api/3/action/package_search?${query}`)
        expect(res.status, query).toBe(409)
        expect((await res.json()).error.__type).toBe('Validation Error')
      }
    })

    it('counts the facets asked for', async () => {
      await createPackage('facet-a', { tags: [{ name: 'x' }, { name: 'y' }] })
      await createPackage('facet-b', { tags: [{ name: 'x' }] })

      const result = await search(`facet.field=${encodeURIComponent('["tags","organization"]')}`)
      expect(result.facets.tags).toEqual({ x: 2, y: 1 })
      expect(result.facets.organization).toEqual({ 'test-org-ckan': 2 })
      expect(result.search_facets.tags).toEqual({
        title: 'tags',
        items: [
          { name: 'x', display_name: 'x', count: 2 },
          { name: 'y', display_name: 'y', count: 1 },
        ],
      })
      expect(result.sort).toBe('score desc, metadata_modified desc')

      // At mincount 0 the values no result carries are named too
      await createPackage('facet-c', { tags: [{ name: 'z' }] })
      const field = `facet.field=${encodeURIComponent('["tags"]')}`
      expect((await search(`fq=tags:y&${field}`)).facets.tags).toEqual({ x: 1, y: 1 })
      expect((await search(`fq=tags:y&facet.mincount=0&${field}`)).facets.tags).toEqual({
        x: 1,
        y: 1,
        z: 0,
      })
      // The same when the fq could never match, answered without a search
      expect((await search(`fq=state:draft&facet.mincount=0&${field}`)).facets.tags).toEqual({
        x: 0,
        y: 0,
        z: 0,
      })
    })
  })
})
