/** The metadata rebuild overwrites, then drops what is left over. */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { packageTable, resource } from '@kukan/db'
import type { DatasetDoc, ResourceDoc, SearchAdapter } from '@kukan/search-adapter'
import { createLogger } from '@kukan/shared'
import { rebuildMetadataIndex } from '../../services/search-index'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const log = createLogger({ name: 'test', level: 'silent' })

/** Just enough of an index to hold documents and page their ids */
function memoryIndex() {
  const packages = new Map<string, DatasetDoc>()
  const resources = new Map<string, ResourceDoc>()
  /** The package count after every write, the thing the health check reads */
  const packageCounts: number[] = []
  const record = () => packageCounts.push(packages.size)
  const page = (ids: Iterable<string>, after?: string, limit = 1_000) =>
    [...ids]
      .sort()
      .filter((id) => after === undefined || id > after)
      .slice(0, limit)
  const search = {
    bulkIndexPackages: async (docs: DatasetDoc[]) => {
      for (const d of docs) packages.set(d.id, d)
      record()
    },
    bulkIndexResources: async (docs: ResourceDoc[]) => {
      for (const d of docs) resources.set(d.id, d)
    },
    deletePackage: async (id: string) => {
      packages.delete(id)
      for (const [rid, r] of resources) if (r.packageId === id) resources.delete(rid)
      record()
    },
    deleteResource: async (id: string) => {
      resources.delete(id)
    },
    indexedDocumentIds: async (type: 'package' | 'resource', after?: string, limit?: number) =>
      page((type === 'package' ? packages : resources).keys(), after, limit),
  } as unknown as SearchAdapter
  return { search, packages, resources, packageCounts }
}

async function seedPackage(state: 'active' | 'draft' | 'deleted' = 'active') {
  const [pkg] = await db
    .insert(packageTable)
    .values({ name: `pkg-${crypto.randomUUID()}`, state })
    .returning({ id: packageTable.id })
  return pkg.id
}

async function seedResource(packageId: string, state: 'active' | 'deleted' = 'active') {
  const [row] = await db
    .insert(resource)
    .values({ packageId, name: 'r.csv', state })
    .returning({ id: resource.id })
  return row.id
}

beforeEach(async () => {
  await cleanDatabase()
})
afterAll(async () => {
  await closeTestDb()
})

describe('rebuildMetadataIndex', () => {
  it('drops the documents whose rows the index may no longer hold, and keeps the rest', async () => {
    const live = await seedPackage()
    const liveResource = await seedResource(live)
    const deletedResource = await seedResource(live, 'deleted')
    const draft = await seedPackage('draft')
    const draftResource = await seedResource(draft)
    const gone = crypto.randomUUID()

    const index = memoryIndex()
    // What an earlier state of the catalogue left behind
    await index.search.bulkIndexPackages([
      { id: live, name: 'live' },
      { id: draft, name: 'draft' },
      { id: gone, name: 'gone' },
    ])
    await index.search.bulkIndexResources([
      { id: liveResource, packageId: live },
      { id: deletedResource, packageId: live },
      { id: draftResource, packageId: draft },
      { id: crypto.randomUUID(), packageId: gone },
    ])

    const result = await rebuildMetadataIndex(db, index.search, log)

    expect([...index.packages.keys()]).toEqual([live])
    expect([...index.resources.keys()]).toEqual([liveResource])
    expect(result).toMatchObject({
      packagesIndexed: 1,
      resourcesIndexed: 1,
      packagesRemoved: 2,
      // The draft's and the vanished package's went with their parents
      resourcesRemoved: 1,
    })
  })

  it('never leaves the index without package documents while it runs', async () => {
    const live = await seedPackage()
    const index = memoryIndex()
    await index.search.bulkIndexPackages([
      { id: live, name: 'live' },
      { id: crypto.randomUUID(), name: 'gone' },
    ])
    index.packageCounts.length = 0

    await rebuildMetadataIndex(db, index.search, log)

    expect(index.packageCounts.length).toBeGreaterThan(0)
    expect(Math.min(...index.packageCounts)).toBeGreaterThan(0)
  })

  it('walks past the first page of ids', async () => {
    const live = await seedPackage()
    const index = memoryIndex()
    const stale = Array.from({ length: 1_001 }, () => ({ id: crypto.randomUUID(), name: 'gone' }))
    await index.search.bulkIndexPackages([{ id: live, name: 'live' }, ...stale])

    const result = await rebuildMetadataIndex(db, index.search, log)

    expect([...index.packages.keys()]).toEqual([live])
    expect(result.packagesRemoved).toBe(1_001)
  })

  it('drops a document whose id no row could have, without failing the query', async () => {
    const live = await seedPackage()
    const index = memoryIndex()
    await index.search.bulkIndexPackages([
      { id: live, name: 'live' },
      { id: 'not-a-uuid', name: 'foreign' },
    ])

    await rebuildMetadataIndex(db, index.search, log)

    expect([...index.packages.keys()]).toEqual([live])
  })
})
