/**
 * Integration tests for the order a package's tags come back in.
 *
 * package_tag has no order column, so an unordered read is left to the plan
 * and the same dataset can list its tags differently on every screen. Each
 * display path sorts by tag name instead.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { PostgresSearchAdapter } from '@kukan/search-adapter'
import type { DatasetDoc, SearchAdapter } from '@kukan/search-adapter'
import { PackageService } from '../../services/package-service'
import { indexPackageMetadata } from '../../services/search-index'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'

const db = getTestDb()

const SORTED = ['apple', 'mango', 'zebra']

let packageId: string

// One read-only fixture for the whole file: the tags are registered in an
// order no plan would sort them into by accident
beforeAll(async () => {
  await cleanDatabase()
  await ensureTestUser()

  const orgResult = await db.execute(sql`
    INSERT INTO organization (name, state) VALUES ('test-org-tag-order', 'active') RETURNING id
  `)
  const orgId = (orgResult.rows[0] as { id: string }).id

  const pkg = await new PackageService(db).create({
    name: 'pkg-tag-order',
    ownerOrg: orgId,
    private: false,
    type: 'dataset',
    extras: {},
    tags: ['zebra', 'apple', 'mango'].map((name) => ({ name })),
    groups: [],
    resources: [],
  })
  packageId = pkg.id
})

afterAll(async () => {
  await closeTestDb()
})

describe('tag display order', () => {
  it('sorts the tags of a dataset detail by name', async () => {
    const detail = await new PackageService(db).getDetailByNameOrId(packageId)

    expect(detail.tags.map((t) => t.name)).toEqual(SORTED)
  })

  it('sorts the tags of a dataset list row by name', async () => {
    const { items } = await new PackageService(db).list({})

    expect(items[0].tags).toBe(SORTED.join(','))
  })

  it('sorts the tags of an indexed search document by name', async () => {
    const indexPackage = vi.fn()

    await indexPackageMetadata(db, { indexPackage } as unknown as SearchAdapter, packageId)

    expect((indexPackage.mock.calls[0][0] as DatasetDoc).tags).toEqual(SORTED)
  })

  it('sorts the tags of a PostgreSQL search result by name', async () => {
    const result = await new PostgresSearchAdapter(db).search({ q: '' })

    expect(result.items[0].tags).toEqual(SORTED)
  })
})
