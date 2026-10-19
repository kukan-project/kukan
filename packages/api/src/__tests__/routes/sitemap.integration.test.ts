import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { publicOrigin } from '@kukan/shared'
import { group, organization, packageTable, packageTag, resource, tag } from '@kukan/db'
import { createTestApp, testEnv } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'

const db = getTestDb()

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
})

afterAll(async () => {
  await closeTestDb()
})

/** A public dataset and the ones a sitemap must leave out, each with a resource and tags */
async function seed() {
  const [org] = await db
    .insert(organization)
    .values([
      { name: 'open-org', state: 'active' },
      { name: 'gone-org', state: 'deleted' },
    ])
    .returning({ id: organization.id })
  await db.insert(group).values([
    { name: 'open-group', state: 'active' },
    { name: 'gone-group', state: 'deleted' },
  ])
  const pkgs = await db
    .insert(packageTable)
    .values([
      { name: 'open', ownerOrg: org.id, state: 'active', private: false },
      { name: 'secret', ownerOrg: org.id, state: 'active', private: true },
      { name: 'draft', ownerOrg: org.id, state: 'draft', private: false },
    ])
    .returning({ id: packageTable.id, name: packageTable.name })
  const idOf = (name: string) => pkgs.find((p) => p.name === name)!.id
  await db.insert(resource).values([
    { packageId: idOf('open'), name: 'shown', state: 'active' },
    { packageId: idOf('open'), name: 'removed', state: 'deleted' },
    { packageId: idOf('secret'), name: 'hidden', state: 'active' },
  ])
  const tags = await db
    .insert(tag)
    .values([
      { name: 'open-tag' },
      { name: 'secret-tag' },
      // Saved before tagNameSchema refused them; no URL path can hold them
      { name: '..' },
      { name: 'a,b' },
      { name: '防災、減災' },
    ])
    .returning({ id: tag.id, name: tag.name })
  const tagId = (name: string) => tags.find((t) => t.name === name)!.id
  await db.insert(packageTag).values([
    { packageId: idOf('open'), tagId: tagId('open-tag') },
    { packageId: idOf('open'), tagId: tagId('..') },
    { packageId: idOf('open'), tagId: tagId('a,b') },
    { packageId: idOf('open'), tagId: tagId('防災、減災') },
    { packageId: idOf('secret'), tagId: tagId('secret-tag') },
  ])
  return { openId: idOf('open') }
}

const ORIGIN = publicOrigin(testEnv)

const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])

describe('the sitemap (/internal/sitemap)', () => {
  it('indexes one file per kind that has public entries, whoever asks', async () => {
    await seed()
    // A sysadmin's request must not widen it: the file is cached for everyone
    for (const app of [createTestApp(db, { user: null }), createTestApp(db)]) {
      const res = await app.request('/internal/sitemap')
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('application/xml; charset=utf-8')
      expect(locs(await res.text())).toEqual(
        ['datasets', 'resources', 'organizations', 'groups', 'tags'].map(
          (kind) => `${ORIGIN}/sitemap/${kind}/0.xml`
        )
      )
    }
  })

  it('lists only public pages, each with when it last changed', async () => {
    const { openId } = await seed()
    const app = createTestApp(db)
    const file = async (kind: string) =>
      (await app.request(`/internal/sitemap/${kind}/0.xml`)).text()
    const [dataset] = await db
      .select({ updated: packageTable.updated })
      .from(packageTable)
      .where(eq(packageTable.id, openId))

    expect(await file('datasets')).toContain(
      `<url><loc>${ORIGIN}/dataset/open</loc><lastmod>${dataset.updated.toISOString()}</lastmod></url>`
    )
    expect(locs(await file('resources'))).toEqual([
      expect.stringMatching(new RegExp(`^${ORIGIN}/dataset/open/resource/[0-9a-f-]+$`)),
    ])
    expect(locs(await file('organizations'))).toEqual([`${ORIGIN}/organization/open-org`])
    expect(locs(await file('groups'))).toEqual([`${ORIGIN}/group/open-group`])
    // Not the private dataset's tag, nor ones a path cannot hold; dated by the dataset
    expect(await file('tags')).toContain(
      `<url><loc>${ORIGIN}/tag/open-tag</loc><lastmod>${dataset.updated.toISOString()}</lastmod></url>`
    )
    expect(locs(await file('tags'))).toHaveLength(1)
  })

  it('answers 404 past the last page and for a path that is no file', async () => {
    await seed()
    const app = createTestApp(db, { user: null })
    for (const path of [
      'datasets/1.xml',
      'users/0.xml',
      'datasets/01.xml',
      'datasets/0.json',
      // An OFFSET past a safe integer, which PostgreSQL would refuse as a bigint
      'datasets/999999999999999999999999.xml',
      `datasets/${Math.ceil(Number.MAX_SAFE_INTEGER / 10_000)}.xml`,
    ]) {
      expect((await app.request(`/internal/sitemap/${path}`)).status).toBe(404)
    }
  })

  it('escapes what XML cannot hold in a URL', async () => {
    await db.insert(packageTable).values({ name: 'open', state: 'active', private: false })
    const [pkg] = await db.select({ id: packageTable.id }).from(packageTable)
    const [t] = await db.insert(tag).values({ name: "a&b'<c>" }).returning({ id: tag.id })
    await db.insert(packageTag).values({ packageId: pkg.id, tagId: t.id })
    const xml = await (await createTestApp(db).request('/internal/sitemap/tags/0.xml')).text()
    expect(locs(xml)).toEqual([`${ORIGIN}/tag/a%26b'%3Cc%3E`.replace("'", '&#39;')])
  })
})
