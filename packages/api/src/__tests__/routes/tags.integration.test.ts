import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { tag, vocabulary } from '@kukan/db'
import { createTestApp } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'
import { TagService } from '../../services/tag-service'

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
