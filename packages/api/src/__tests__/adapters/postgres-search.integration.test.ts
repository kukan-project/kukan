import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import {
  getTestDb,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  TEST_USER_ID,
} from '../test-helpers/test-db'
import { PostgresSearchAdapter } from '@kukan/search-adapter'
import {
  organization,
  packageTable,
  packageTag,
  tag,
  resource,
  group,
  packageGroup,
} from '@kukan/db'
import { eq } from 'drizzle-orm'

const db = getTestDb()
const adapter = new PostgresSearchAdapter(db)

let defaultOrgId: string

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
  const [org] = await db
    .insert(organization)
    .values({ name: 'default-org', title: 'Default Org' })
    .returning()
  defaultOrgId = org.id
})

afterAll(async () => {
  await closeTestDb()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertPkg(data: {
  name: string
  title?: string
  notes?: string
  ownerOrg?: string
  licenseId?: string
  private?: boolean
}) {
  const [pkg] = await db
    .insert(packageTable)
    .values({
      name: data.name,
      title: data.title,
      notes: data.notes,
      ownerOrg: data.ownerOrg ?? defaultOrgId,
      licenseId: data.licenseId,
      private: data.private ?? false,
      creatorUserId: TEST_USER_ID,
    })
    .returning()
  return pkg
}

async function addTags(packageId: string, tagNames: string[]) {
  for (const name of tagNames) {
    const existing = await db.select().from(tag).where(eq(tag.name, name))
    const tagId =
      existing.length > 0
        ? existing[0].id
        : (await db.insert(tag).values({ name }).returning())[0].id
    await db.insert(packageTag).values({ packageId, tagId })
  }
}

async function addResource(packageId: string, data: { name: string; format: string }) {
  await db.insert(resource).values({
    packageId,
    name: data.name,
    format: data.format,
  })
}

async function insertGroup(name: string) {
  const [grp] = await db.insert(group).values({ name, title: name }).returning()
  return grp
}

async function insertOrg(name: string) {
  const [org] = await db.insert(organization).values({ name, title: name }).returning()
  return org
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostgresSearchAdapter', () => {
  describe('text search', () => {
    it('should find packages by title', async () => {
      await insertPkg({ name: 'population', title: 'Population Statistics' })
      await insertPkg({ name: 'weather', title: 'Weather Data' })

      const result = await adapter.search({ q: 'population' })
      expect(result.total).toBe(1)
      expect(result.items[0].name).toBe('population')
    })

    it('should find packages by resource name', async () => {
      const pkg = await insertPkg({ name: 'data-pkg', title: 'Some Data' })
      await addResource(pkg.id, { name: 'quarterly-report.csv', format: 'CSV' })
      await insertPkg({ name: 'other-pkg', title: 'Other' })

      const result = await adapter.search({ q: 'quarterly-report' })
      expect(result.total).toBe(1)
      expect(result.items[0].name).toBe('data-pkg')
      expect(result.items[0].matchedResources).toHaveLength(1)
      expect(result.items[0].matchedResources![0].name).toBe('quarterly-report.csv')
    })

    it('should return all active packages for empty query', async () => {
      await insertPkg({ name: 'pkg-a' })
      await insertPkg({ name: 'pkg-b' })

      const result = await adapter.search({ q: '' })
      expect(result.total).toBe(2)
    })
  })

  describe('tags filter (AND)', () => {
    it('should return only packages with ALL selected tags', async () => {
      const pkgAB = await insertPkg({ name: 'pkg-ab' })
      await addTags(pkgAB.id, ['env', 'health'])

      const pkgA = await insertPkg({ name: 'pkg-a' })
      await addTags(pkgA.id, ['env', 'transport'])

      const pkgB = await insertPkg({ name: 'pkg-b' })
      await addTags(pkgB.id, ['health', 'education'])

      const result = await adapter.search({
        q: '',
        filters: { tags: ['env', 'health'] },
      })
      expect(result.total).toBe(1)
      expect(result.items[0].name).toBe('pkg-ab')
    })

    it('should return empty when no package has all tags', async () => {
      const pkg = await insertPkg({ name: 'pkg-single' })
      await addTags(pkg.id, ['env'])

      const result = await adapter.search({
        q: '',
        filters: { tags: ['env', 'health'] },
      })
      expect(result.total).toBe(0)
    })
  })

  describe('formats filter (AND)', () => {
    it('should return only packages with ALL selected formats', async () => {
      const pkgBoth = await insertPkg({ name: 'pkg-both' })
      await addResource(pkgBoth.id, { name: 'a.csv', format: 'CSV' })
      await addResource(pkgBoth.id, { name: 'a.json', format: 'JSON' })

      const pkgCsv = await insertPkg({ name: 'pkg-csv' })
      await addResource(pkgCsv.id, { name: 'b.csv', format: 'CSV' })

      const pkgJson = await insertPkg({ name: 'pkg-json' })
      await addResource(pkgJson.id, { name: 'c.json', format: 'JSON' })

      const result = await adapter.search({
        q: '',
        filters: { formats: ['CSV', 'JSON'] },
      })
      expect(result.total).toBe(1)
      expect(result.items[0].name).toBe('pkg-both')
    })

    it('should be case-insensitive for format matching', async () => {
      const pkg = await insertPkg({ name: 'pkg-csv' })
      await addResource(pkg.id, { name: 'a.csv', format: 'csv' })

      const result = await adapter.search({
        q: '',
        filters: { formats: ['CSV'] },
      })
      expect(result.total).toBe(1)
    })
  })

  describe('organizations filter (OR)', () => {
    it('should return packages from ANY selected organization', async () => {
      const org1 = await insertOrg('org-alpha')
      const org2 = await insertOrg('org-beta')
      const org3 = await insertOrg('org-gamma')

      await insertPkg({ name: 'pkg-alpha', ownerOrg: org1.id })
      await insertPkg({ name: 'pkg-beta', ownerOrg: org2.id })
      await insertPkg({ name: 'pkg-gamma', ownerOrg: org3.id })

      const result = await adapter.search({
        q: '',
        filters: { organizations: ['org-alpha', 'org-beta'] },
      })
      expect(result.total).toBe(2)
      const names = result.items.map((i) => i.name).sort()
      expect(names).toEqual(['pkg-alpha', 'pkg-beta'])
    })
  })

  describe('licenses filter (OR)', () => {
    it('should return packages with ANY selected license', async () => {
      await insertPkg({ name: 'pkg-cc', licenseId: 'cc-by' })
      await insertPkg({ name: 'pkg-mit', licenseId: 'mit' })
      await insertPkg({ name: 'pkg-apache', licenseId: 'apache-2.0' })

      const result = await adapter.search({
        q: '',
        filters: { licenses: ['cc-by', 'mit'] },
      })
      expect(result.total).toBe(2)
      const names = result.items.map((i) => i.name).sort()
      expect(names).toEqual(['pkg-cc', 'pkg-mit'])
    })
  })

  describe('groups filter (AND)', () => {
    it('should return only packages in ALL selected groups', async () => {
      const grp1 = await insertGroup('environment')
      const grp2 = await insertGroup('transport')
      const grp3 = await insertGroup('health')

      const pkgBoth = await insertPkg({ name: 'pkg-env-trans' })
      const pkgOne = await insertPkg({ name: 'pkg-env-only' })
      const pkgOther = await insertPkg({ name: 'pkg-trans-health' })

      await db.insert(packageGroup).values([
        { packageId: pkgBoth.id, groupId: grp1.id },
        { packageId: pkgBoth.id, groupId: grp2.id },
        { packageId: pkgOne.id, groupId: grp1.id },
        { packageId: pkgOther.id, groupId: grp2.id },
        { packageId: pkgOther.id, groupId: grp3.id },
      ])

      const result = await adapter.search({
        q: '',
        filters: { groups: ['environment', 'transport'] },
      })
      expect(result.total).toBe(1)
      expect(result.items[0].name).toBe('pkg-env-trans')
    })
  })

  describe('combined filters', () => {
    it('should AND across categories — tags AND formats AND license', async () => {
      // pkg-match: tag=env, format=CSV, license=cc-by
      const pkgMatch = await insertPkg({ name: 'pkg-match', licenseId: 'cc-by' })
      await addTags(pkgMatch.id, ['env'])
      await addResource(pkgMatch.id, { name: 'a.csv', format: 'CSV' })

      // pkg-no-tag: format=CSV, license=cc-by, but no env tag
      const pkgNoTag = await insertPkg({ name: 'pkg-no-tag', licenseId: 'cc-by' })
      await addTags(pkgNoTag.id, ['health'])
      await addResource(pkgNoTag.id, { name: 'b.csv', format: 'CSV' })

      // pkg-no-format: tag=env, license=cc-by, but no CSV
      const pkgNoFmt = await insertPkg({ name: 'pkg-no-format', licenseId: 'cc-by' })
      await addTags(pkgNoFmt.id, ['env'])
      await addResource(pkgNoFmt.id, { name: 'c.json', format: 'JSON' })

      const result = await adapter.search({
        q: '',
        filters: { tags: ['env'], formats: ['CSV'], licenses: ['cc-by'] },
      })
      expect(result.total).toBe(1)
      expect(result.items[0].name).toBe('pkg-match')
    })
  })

  describe('facets', () => {
    it('should return facet counts', async () => {
      const pkg1 = await insertPkg({ name: 'pkg-1', licenseId: 'cc-by' })
      await addTags(pkg1.id, ['env', 'health'])
      await addResource(pkg1.id, { name: 'a.csv', format: 'CSV' })

      const pkg2 = await insertPkg({ name: 'pkg-2', licenseId: 'cc-by' })
      await addTags(pkg2.id, ['env'])
      await addResource(pkg2.id, { name: 'b.json', format: 'JSON' })

      const result = await adapter.search({ q: '', facets: true })

      expect(result.facets).toBeDefined()
      expect(result.facets!.organizations).toEqual([{ name: 'default-org', count: 2 }])
      expect(result.facets!.tags).toEqual(
        expect.arrayContaining([
          { name: 'env', count: 2 },
          { name: 'health', count: 1 },
        ])
      )
      expect(result.facets!.formats).toEqual(
        expect.arrayContaining([
          { name: 'CSV', count: 1 },
          { name: 'JSON', count: 1 },
        ])
      )
      expect(result.facets!.licenses).toEqual([{ name: 'cc-by', count: 2 }])
    })

    it('should not return facets when not requested', async () => {
      await insertPkg({ name: 'pkg-1' })

      const result = await adapter.search({ q: '' })
      expect(result.facets).toBeUndefined()
    })
  })

  describe('visibility', () => {
    it('should exclude private packages when excludePrivate is set', async () => {
      await insertPkg({ name: 'public-pkg', private: false })
      await insertPkg({ name: 'private-pkg', private: true })

      const result = await adapter.search({
        q: '',
        filters: { excludePrivate: true },
      })
      expect(result.total).toBe(1)
      expect(result.items[0].name).toBe('public-pkg')
    })

    it('should allow private packages for specified org IDs', async () => {
      await insertPkg({ name: 'public-pkg', private: false })
      await insertPkg({ name: 'private-pkg', private: true })

      const result = await adapter.search({
        q: '',
        filters: { excludePrivate: true, allowPrivateOrgIds: [defaultOrgId] },
      })
      expect(result.total).toBe(2)
    })
  })

  describe('pagination', () => {
    it('should respect offset and limit', async () => {
      for (let i = 0; i < 5; i++) {
        await insertPkg({ name: `pkg-${i}` })
      }

      const result = await adapter.search({ q: '', offset: 2, limit: 2 })
      expect(result.items).toHaveLength(2)
      expect(result.total).toBe(5)
      expect(result.offset).toBe(2)
      expect(result.limit).toBe(2)
    })
  })
})
