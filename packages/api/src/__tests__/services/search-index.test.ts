import { describe, it, expect, vi } from 'vitest'
import { createMockDb } from '../test-helpers/mock-db'
import {
  indexPackageMetadata,
  enqueuePackageEmbed,
  syncPackageMetadata,
} from '../../services/search-index'
import { EMBED_JOB_TYPE, type Logger } from '@kukan/shared'
import type { SearchAdapter, DatasetDoc } from '@kukan/search-adapter'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'

const EMBED_PACKAGE_ID = '00000000-0000-4000-8000-000000000001'

function makeQueue() {
  return { enqueue: vi.fn().mockResolvedValue('job-1') } as unknown as QueueAdapter
}

function makeAI(embeddingAvailable: boolean) {
  return {
    getEmbeddingInfo: () => (embeddingAvailable ? { model: 'test-model', dimensions: 4 } : null),
  } as unknown as AIAdapter
}

function makeLogger() {
  return { error: vi.fn() } as unknown as Logger
}

function createMockSearch() {
  const indexed: DatasetDoc[] = []
  const adapter: SearchAdapter = {
    indexPackage: vi.fn(async (doc: DatasetDoc) => {
      indexed.push(doc)
    }),
    deletePackage: vi.fn(),
    bulkIndexPackages: vi.fn(),
    deleteAllPackages: vi.fn(),
    search: vi.fn(),
    sumResourceCount: vi.fn(),
    indexResource: vi.fn(),
    bulkIndexResources: vi.fn(),
    deleteResource: vi.fn(),
    deleteAllResources: vi.fn(),
    indexContent: vi.fn(),
    deleteContent: vi.fn(),
    deleteAllContents: vi.fn(),
    getIndexStats: vi.fn(),
    getDocument: vi.fn(),
    browseDocuments: vi.fn(),
    getContentChunks: vi.fn(),
    browseContentsByResource: vi.fn(),
    fetchContentHighlights: vi.fn(),
  }
  return { adapter, indexed }
}

const now = new Date('2024-06-01T00:00:00Z')

describe('indexPackageMetadata', () => {
  it('should build and index a DatasetDoc without resources', async () => {
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
    // 3. Promise.all: resources (format only, for facets)
    addResult([{ format: 'csv' }, { format: 'PDF' }])
    // 4. Promise.all: groups
    addResult([{ name: 'science' }, { name: 'open-data' }])
    // 5. Promise.all: tags
    addResult([{ name: 'environment' }, { name: 'tokyo' }])

    await indexPackageMetadata(db, adapter, 'pkg-1')

    expect(adapter.indexPackage).toHaveBeenCalledOnce()
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
    // Resources should NOT be included in dataset doc
    expect(doc['resources']).toBeUndefined()
  })

  it('should skip indexing when package is not found', async () => {
    const { db, addResult } = createMockDb()
    const { adapter } = createMockSearch()

    addResult([]) // no package found

    await indexPackageMetadata(db, adapter, 'pkg-missing')

    expect(adapter.indexPackage).not.toHaveBeenCalled()
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
    // resources (format only)
    addResult([])
    // ownerOrg is null, so org query is skipped (Promise.resolve(null))
    // groups
    addResult([])
    // tags
    addResult([])

    await indexPackageMetadata(db, adapter, 'pkg-2')

    expect(indexed).toHaveLength(1)
    const doc = indexed[0]
    expect(doc.organization).toBeUndefined()
    expect(doc.title).toBeUndefined()
    expect(doc.notes).toBeUndefined()
    expect(doc.license_id).toBeUndefined()
    expect(doc.groups).toEqual([])
    expect(doc.tags).toEqual([])
    expect(doc.formats).toEqual([])
    expect(doc['resources']).toBeUndefined()
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
    addResult([{ format: 'csv' }, { format: 'CSV' }, { format: 'json' }])
    addResult([]) // groups
    addResult([]) // tags

    await indexPackageMetadata(db, adapter, 'pkg-3')

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
    addResult([{ format: null }])
    addResult([]) // groups
    addResult([]) // tags

    await indexPackageMetadata(db, adapter, 'pkg-4')

    expect(indexed[0].formats).toEqual([])
  })
})

describe('enqueuePackageEmbed', () => {
  it('enqueues an embed-package job when embedding is available', async () => {
    const queue = makeQueue()
    await enqueuePackageEmbed(queue, makeAI(true), EMBED_PACKAGE_ID, makeLogger())
    expect(queue.enqueue).toHaveBeenCalledWith(EMBED_JOB_TYPE, { packageId: EMBED_PACKAGE_ID })
  })

  it('does nothing when embedding is unavailable (NoOp)', async () => {
    const queue = makeQueue()
    await enqueuePackageEmbed(queue, makeAI(false), EMBED_PACKAGE_ID, makeLogger())
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('swallows enqueue failures (logs, never throws)', async () => {
    const queue = {
      enqueue: vi.fn().mockRejectedValue(new Error('queue down')),
    } as unknown as QueueAdapter
    const logger = makeLogger()
    await expect(
      enqueuePackageEmbed(queue, makeAI(true), EMBED_PACKAGE_ID, logger)
    ).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('syncPackageMetadata', () => {
  it('enqueues the embed job alongside the index update', async () => {
    const { db, addResult } = createMockDb()
    addResult([]) // package select: not found — the index half returns early
    const { adapter } = createMockSearch()
    const queue = makeQueue()

    await syncPackageMetadata(
      db,
      { search: adapter, queue, ai: makeAI(true), logger: makeLogger() },
      EMBED_PACKAGE_ID
    )

    expect(queue.enqueue).toHaveBeenCalledWith(EMBED_JOB_TYPE, { packageId: EMBED_PACKAGE_ID })
  })
})
