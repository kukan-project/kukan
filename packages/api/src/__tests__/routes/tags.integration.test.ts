import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { tag, vocabulary, packageTable, packageTag } from '@kukan/db'
import { createTestApp } from '../test-helpers/test-app'
import {
  getTestDb,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  ensureOutsiderUser,
  OUTSIDER_USER_ID,
} from '../test-helpers/test-db'
import { TagService } from '../../services/tag-service'

const db = getTestDb()
const app = createTestApp(db)
const outsiderApp = createTestApp(db, {
  user: {
    id: OUTSIDER_USER_ID,
    email: 'outsider@example.com',
    name: 'outsider',
    sysadmin: false,
  },
})

const json = (data: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
})

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
      body: JSON.stringify({ name, ownerOrg: orgId, tags: tags.map((t) => ({ name: t })) }),
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

    it('should not leak draft-only tags to the public list, candidates, or detail', async () => {
      const orgId = await ensureTestOrg()
      // An active package's tag is public; a draft-only tag must not be
      await createPackageWithTags('active-pkg', ['public-tag'])
      const draftRes = await app.request('/api/v1/packages/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerOrg: orgId, tags: [{ name: 'draft-only-tag' }] }),
      })
      expect(draftRes.status).toBe(201)

      // Public /tags and the AI candidate list exclude the draft-only tag
      const names = (await (await app.request('/api/v1/tags')).json()).items.map(
        (t: { name: string }) => t.name
      )
      expect(names).toContain('public-tag')
      expect(names).not.toContain('draft-only-tag')

      const { items } = await new TagService(db).list({ limit: 10, orderBy: 'packageCount' })
      expect(items.map((t) => t.name)).not.toContain('draft-only-tag')

      // Detail lookup 404s for a tag with no active package
      const [draftTag] = await db.select().from(tag).where(eq(tag.name, 'draft-only-tag'))
      expect(draftTag).toBeDefined()
      const detail = await app.request(`/api/v1/tags/${draftTag.id}`)
      expect(detail.status).toBe(404)
    })

    it('keeps unused controlled-vocabulary tags visible', async () => {
      // Vocabulary tags are managed explicitly (never GC'd) and part of the
      // tag_list contract, so they stay listed even with no active package
      const [vocab] = await db.insert(vocabulary).values({ name: 'themes' }).returning()
      const [vTag] = await db
        .insert(tag)
        .values({ name: 'controlled-term', vocabularyId: vocab.id })
        .returning()

      const found = (await (await app.request('/api/v1/tags')).json()).items.find(
        (t: { name: string }) => t.name === 'controlled-term'
      )
      expect(found).toBeDefined()
      expect(found.packageCount).toBe(0)

      const detail = await app.request(`/api/v1/tags/${vTag.id}`)
      expect(detail.status).toBe(200)
    })
  })

  // A free tag used only by datasets the viewer cannot see must not surface —
  // the tag name itself is the leak (e.g. an internal project name), and even
  // on a public tag the count must not include invisible usage.
  describe('tag visibility (private datasets)', () => {
    beforeEach(async () => {
      await ensureOutsiderUser()
      await createPackageWithTags('vis-public-pkg', ['shared-tag', 'public-tag'])
      const otherOrgId = await ensureTestOrg()
      const mine = await (
        await app.request('/api/v1/organizations', json({ name: 'tags-org-mine' }))
      ).json()
      await app.request(
        '/api/v1/organizations/tags-org-mine/members',
        json({ user_id: OUTSIDER_USER_ID, role: 'member' })
      )
      await app.request(
        '/api/v1/packages',
        json({
          name: 'vis-private-mine',
          ownerOrg: mine.id,
          private: true,
          tags: [{ name: 'shared-tag' }, { name: 'private-mine-tag' }],
        })
      )
      await app.request(
        '/api/v1/packages',
        json({
          name: 'vis-private-other',
          ownerOrg: otherOrgId,
          private: true,
          tags: [{ name: 'shared-tag' }, { name: 'private-other-tag' }],
        })
      )
    })

    async function listAs(client: typeof app) {
      const body = await (await client.request('/api/v1/tags')).json()
      return Object.fromEntries(
        body.items.map((t: { name: string; packageCount: number }) => [t.name, t.packageCount])
      )
    }

    it('should hide private-only tags and their usage from anonymous callers', async () => {
      expect(await listAs(createTestApp(db, { user: null }))).toEqual({
        'shared-tag': 1,
        'public-tag': 1,
      })
    })

    it("should add the viewer's own orgs' private usage", async () => {
      expect(await listAs(outsiderApp)).toEqual({
        'shared-tag': 2,
        'public-tag': 1,
        'private-mine-tag': 1,
      })
    })

    it('should list everything for a sysadmin', async () => {
      expect(await listAs(app)).toEqual({
        'shared-tag': 3,
        'public-tag': 1,
        'private-mine-tag': 1,
        'private-other-tag': 1,
      })
    })

    it('should apply the same visibility on the detail endpoint', async () => {
      const [privateTag] = await db.select().from(tag).where(eq(tag.name, 'private-other-tag'))
      const anonApp = createTestApp(db, { user: null })
      expect((await anonApp.request(`/api/v1/tags/${privateTag.id}`)).status).toBe(404)
      expect((await outsiderApp.request(`/api/v1/tags/${privateTag.id}`)).status).toBe(404)
      expect((await app.request(`/api/v1/tags/${privateTag.id}`)).status).toBe(200)

      // Counts on a visible tag stay scoped to the viewer as well
      const [sharedTag] = await db.select().from(tag).where(eq(tag.name, 'shared-tag'))
      const anonDetail = await (await anonApp.request(`/api/v1/tags/${sharedTag.id}`)).json()
      expect(anonDetail.packageCount).toBe(1)
    })

    it('should not match private-only tags via q search', async () => {
      const anonApp = createTestApp(db, { user: null })
      const body = await (await anonApp.request('/api/v1/tags?q=private-other')).json()
      expect(body.items).toEqual([])
      expect(body.total).toBe(0)
    })

    // Vocabulary tags always stay listed (tag_list contract), so for them the
    // leak surface is the count alone
    it('should keep vocabulary tags visible but scope their count', async () => {
      const [vocab] = await db.insert(vocabulary).values({ name: 'vis-themes' }).returning()
      const [vTag] = await db
        .insert(tag)
        .values({ name: 'vis-controlled', vocabularyId: vocab.id })
        .returning()
      const [privatePkg] = await db
        .select()
        .from(packageTable)
        .where(eq(packageTable.name, 'vis-private-other'))
      await db.insert(packageTag).values({ packageId: privatePkg.id, tagId: vTag.id })

      const anonApp = createTestApp(db, { user: null })
      const anon = await (await anonApp.request(`/api/v1/tags/${vTag.id}`)).json()
      expect(anon.packageCount).toBe(0)
      const sysadmin = await (await app.request(`/api/v1/tags/${vTag.id}`)).json()
      expect(sysadmin.packageCount).toBe(1)
    })

    it('should scope the AI candidate list to the suggest user', async () => {
      const anonymous = await new TagService(db).list({ limit: 10, orderBy: 'packageCount' })
      expect(anonymous.items.map((t) => t.name)).not.toContain('private-mine-tag')

      const asOutsider = await new TagService(db).list(
        { limit: 10, orderBy: 'packageCount' },
        { id: OUTSIDER_USER_ID, sysadmin: false }
      )
      expect(asOutsider.items.map((t) => t.name)).toContain('private-mine-tag')
      expect(asOutsider.items.map((t) => t.name)).not.toContain('private-other-tag')
    })
  })

  describe('TagService.list orderBy packageCount (ADR-040 tag candidates)', () => {
    it('should order tags by usage, most-used first', async () => {
      await createPackageWithTags('order-pkg-1', ['人気タグ', 'ふつうタグ'])
      await createPackageWithTags('order-pkg-2', ['人気タグ', 'ふつうタグ'])
      await createPackageWithTags('order-pkg-3', ['人気タグ', 'レアタグ'])

      const { items } = await new TagService(db).list({ limit: 10, orderBy: 'packageCount' })
      expect(items.map((t) => t.name)).toEqual(['人気タグ', 'ふつうタグ', 'レアタグ'])
      expect(items[0].packageCount).toBe(3)
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
