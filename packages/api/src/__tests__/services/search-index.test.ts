import { describe, it, expect, vi } from 'vitest'
import { createMockDb } from '../test-helpers/mock-db'
import { indexPackage } from '../../services/search-index'
import type { SearchAdapter, DatasetDoc } from '@kukan/search-adapter'

function createMockSearch() {
  const indexed: DatasetDoc[] = []
  const adapter: SearchAdapter = {
    index: vi.fn(async (doc: DatasetDoc) => {
      indexed.push(doc)
    }),
    search: vi.fn(),
    delete: vi.fn(),
    deleteAll: vi.fn(),
    bulkIndex: vi.fn(),
  }
  return { adapter, indexed }
}

const now = new Date('2024-06-01T00:00:00Z')

describe('indexPackage', () => {
  it('should build and index a complete DatasetDoc', async () => {
    const { db, addResult } = createMockDb()
    const { adapter, indexed } = createMockSearch()

    // 1. package select
    addResult([
      {
        id: 'pkg-1',
        name: 'test-dataset',
        title: 'Test Dataset',
        notes: 'Some description',
        ownerOrg: 'org-1',
        private: false,
        creatorUserId: 'user-1',
        licenseId: 'MIT',
        created: now,
        updated: now,
      },
    ])
    // 2. Promise.all: organization (explicit .then() consumes result before Promise.all resolves)
    addResult([{ name: 'my-org' }])
    // 3. Promise.all: resources
    addResult([
      { id: 'res-1', name: 'data.csv', description: 'CSV file', format: 'csv' },
      { id: 'res-2', name: 'info.pdf', description: null, format: 'PDF' },
    ])
    // 4. Promise.all: groups
    addResult([{ name: 'science' }, { name: 'open-data' }])
    // 5. Promise.all: tags
    addResult([{ name: 'environment' }, { name: 'tokyo' }])

    await indexPackage(db, adapter, 'pkg-1')

    expect(adapter.index).toHaveBeenCalledOnce()
    expect(indexed).toHaveLength(1)

    const doc = indexed[0]
    expect(doc.id).toBe('pkg-1')
    expect(doc.name).toBe('test-dataset')
    expect(doc.title).toBe('Test Dataset')
    expect(doc.notes).toBe('Some description')
    expect(doc.organization).toBe('my-org')
    expect(doc.license_id).toBe('MIT')
    expect(doc.private).toBe(false)
    expect(doc.owner_org_id).toBe('org-1')
    expect(doc.creator_user_id).toBe('user-1')
    expect(doc.groups).toEqual(['science', 'open-data'])
    expect(doc.tags).toEqual(['environment', 'tokyo'])
    expect(doc.formats).toEqual(expect.arrayContaining(['CSV', 'PDF']))
    const resources = doc['resources'] as { id: string; name?: string; description?: string; format?: string }[]
    expect(resources).toHaveLength(2)
    expect(resources[0]).toEqual({
      id: 'res-1',
      name: 'data.csv',
      description: 'CSV file',
      format: 'csv',
    })
  })

  it('should skip indexing when package is not found', async () => {
    const { db, addResult } = createMockDb()
    const { adapter } = createMockSearch()

    addResult([]) // no package found

    await indexPackage(db, adapter, 'pkg-missing')

    expect(adapter.index).not.toHaveBeenCalled()
  })

  it('should handle package without organization', async () => {
    const { db, addResult } = createMockDb()
    const { adapter, indexed } = createMockSearch()

    addResult([
      {
        id: 'pkg-2',
        name: 'no-org',
        title: null,
        notes: null,
        ownerOrg: null,
        private: false,
        creatorUserId: 'user-1',
        licenseId: null,
        created: now,
        updated: now,
      },
    ])
    // resources
    addResult([])
    // ownerOrg is null, so org query is skipped (Promise.resolve(null))
    // groups
    addResult([])
    // tags
    addResult([])

    await indexPackage(db, adapter, 'pkg-2')

    expect(indexed).toHaveLength(1)
    const doc = indexed[0]
    expect(doc.organization).toBeUndefined()
    expect(doc.title).toBeUndefined()
    expect(doc.notes).toBeUndefined()
    expect(doc.license_id).toBeUndefined()
    expect(doc.groups).toEqual([])
    expect(doc.tags).toEqual([])
    expect(doc.formats).toEqual([])
    expect(doc['resources']).toEqual([])
  })

  it('should deduplicate formats (case-insensitive uppercase)', async () => {
    const { db, addResult } = createMockDb()
    const { adapter, indexed } = createMockSearch()

    addResult([
      {
        id: 'pkg-3',
        name: 'dup-formats',
        title: null,
        notes: null,
        ownerOrg: null,
        private: false,
        creatorUserId: 'user-1',
        licenseId: null,
        created: now,
        updated: now,
      },
    ])
    // resources with duplicate formats (different casing)
    addResult([
      { id: 'r1', name: 'a.csv', description: null, format: 'csv' },
      { id: 'r2', name: 'b.csv', description: null, format: 'CSV' },
      { id: 'r3', name: 'c.json', description: null, format: 'json' },
    ])
    addResult([]) // groups
    addResult([]) // tags

    await indexPackage(db, adapter, 'pkg-3')

    const doc = indexed[0]
    expect(doc.formats).toEqual(['CSV', 'JSON'])
  })

  it('should exclude resources with null format from formats list', async () => {
    const { db, addResult } = createMockDb()
    const { adapter, indexed } = createMockSearch()

    addResult([
      {
        id: 'pkg-4',
        name: 'null-fmt',
        title: null,
        notes: null,
        ownerOrg: null,
        private: false,
        creatorUserId: 'user-1',
        licenseId: null,
        created: now,
        updated: now,
      },
    ])
    addResult([{ id: 'r1', name: 'unknown', description: null, format: null }])
    addResult([]) // groups
    addResult([]) // tags

    await indexPackage(db, adapter, 'pkg-4')

    expect(indexed[0].formats).toEqual([])
    expect(indexed[0]['resources']).toEqual([
      { id: 'r1', name: 'unknown', description: undefined, format: undefined },
    ])
  })
})
