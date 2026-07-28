/**
 * Integration tests for orphaned free-tag garbage collection.
 *
 * Free tags are created on demand when linked to a package; when the last
 * link disappears (package update / purge, org purge) the tag row must be
 * deleted too, or it lingers forever in facets and tag lists.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { PackageService } from '../../services/package-service'
import { OrganizationService } from '../../services/organization-service'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'

const db = getTestDb()

const mockStorage = {
  deleteByPrefix: async () => {},
} as unknown as StorageAdapter

let orgId: string

async function tagNames(): Promise<string[]> {
  const result = await db.execute(sql`SELECT name FROM tag ORDER BY name`)
  return result.rows.map((r) => (r as { name: string }).name)
}

function packageInput(name: string, tags: string[]) {
  return {
    name,
    ownerOrg: orgId,
    private: false,
    type: 'dataset',
    extras: {},
    tags: tags.map((t) => ({ name: t })),
    groups: [],
  }
}

function createInput(name: string, tags: string[]) {
  return { ...packageInput(name, tags), resources: [] }
}

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()

  const orgResult = await db.execute(sql`
    INSERT INTO organization (name, state) VALUES ('test-org-tag-gc', 'active') RETURNING id
  `)
  orgId = (orgResult.rows[0] as { id: string }).id
})

afterAll(async () => {
  await closeTestDb()
})

describe('orphan free-tag GC', () => {
  describe('PackageService.update', () => {
    it('deletes tags that lost their last link', async () => {
      const service = new PackageService(db)
      const pkg = await service.create(createInput('pkg-a', ['keep', 'drop']))

      await service.update(pkg.id, packageInput('pkg-a', ['keep']))

      expect(await tagNames()).toEqual(['keep'])
    })

    it('keeps tags still linked to another package', async () => {
      const service = new PackageService(db)
      await service.create(createInput('pkg-a', ['shared']))
      const pkg = await service.create(createInput('pkg-b', ['shared']))

      await service.update(pkg.id, packageInput('pkg-b', []))

      expect(await tagNames()).toEqual(['shared'])
    })

    it('never collects vocabulary tags', async () => {
      const service = new PackageService(db)
      const pkg = await service.create(createInput('pkg-a', []))

      const vocabResult = await db.execute(sql`
        INSERT INTO vocabulary (name) VALUES ('themes') RETURNING id
      `)
      const vocabId = (vocabResult.rows[0] as { id: string }).id
      const vocabTagResult = await db.execute(sql`
        INSERT INTO tag (name, vocabulary_id) VALUES ('vocab-tag', ${vocabId}) RETURNING id
      `)
      const vocabTagId = (vocabTagResult.rows[0] as { id: string }).id
      await db.execute(sql`
        INSERT INTO package_tag (package_id, tag_id) VALUES (${pkg.id}, ${vocabTagId})
      `)

      // Re-linking replaces all links, orphaning the vocabulary tag
      await service.update(pkg.id, packageInput('pkg-a', []))

      expect(await tagNames()).toEqual(['vocab-tag'])
    })
  })

  describe('PackageService.purge', () => {
    it('deletes tags orphaned by the purged package', async () => {
      const service = new PackageService(db)
      await service.create(createInput('pkg-a', ['shared']))
      const pkg = await service.create(createInput('pkg-b', ['shared', 'solo']))

      await service.delete(pkg.id)
      await service.purge(pkg.id, { storage: mockStorage })

      expect(await tagNames()).toEqual(['shared'])
    })
  })

  describe('OrganizationService.purgeDeletedOrg', () => {
    it('deletes tags orphaned by the purged packages', async () => {
      const pkgService = new PackageService(db)
      await pkgService.create(createInput('pkg-a', ['org-tag-1']))
      await pkgService.create(createInput('pkg-b', ['org-tag-2']))

      const otherOrgResult = await db.execute(sql`
        INSERT INTO organization (name, state) VALUES ('other-org', 'active') RETURNING id
      `)
      const otherOrgId = (otherOrgResult.rows[0] as { id: string }).id
      await pkgService.create({ ...createInput('pkg-other', ['other-tag']), ownerOrg: otherOrgId })

      await db.execute(sql`UPDATE organization SET state = 'deleted' WHERE id = ${orgId}`)

      const orgService = new OrganizationService(db)
      const result = await orgService.purgeDeletedOrg(orgId, { storage: mockStorage })

      expect(result).toEqual({ purged: true, packageCount: 2 })
      expect(await tagNames()).toEqual(['other-tag'])
    })
  })
})
