import { describe, it, expect, vi } from 'vitest'
import { PIPELINE_JOB_TYPE } from '@kukan/shared'
import { buildPipelineContext, registerPipelineHandler } from '../../queue/pipeline-handler'

// Mock @kukan/pipeline
vi.mock('@kukan/pipeline', () => ({
  processResource: vi.fn(),
}))

import { processResource } from '@kukan/pipeline'

// Mock @kukan/db schema
vi.mock('@kukan/db', () => ({
  resource: {
    id: 'id',
    packageId: 'package_id',
    url: 'url',
    urlType: 'url_type',
    format: 'format',
    hash: 'hash',
    name: 'name',
    description: 'description',
    state: 'state',
  },
  packageTable: {
    id: 'id',
    name: 'name',
    title: 'title',
    notes: 'notes',
    ownerOrg: 'owner_org',
  },
}))

// Mock drizzle-orm
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col, val) => ({ col, val, type: 'eq' })),
  and: vi.fn((...conditions) => ({ conditions, type: 'and' })),
  sql: Object.assign((strings: TemplateStringsArray) => strings.join(''), { raw: vi.fn() }),
}))

function createMockDb() {
  const results: unknown[][] = []
  let callIndex = 0

  const self = {
    select: vi.fn(() => self),
    from: vi.fn(() => self),
    where: vi.fn(() => {
      const result = results[callIndex++] ?? []
      return {
        ...self,
        limit: vi.fn(() => result),
        then: (resolve: (v: unknown) => void) => resolve(result),
      }
    }),
    limit: vi.fn(() => results[callIndex++] ?? []),
    update: vi.fn(() => self),
    set: vi.fn(() => self),
  }

  return {
    db: self as unknown as Parameters<typeof buildPipelineContext>[0],
    addResult: (result: unknown[]) => results.push(result),
  }
}

describe('buildPipelineContext', () => {
  const mockStorage = {
    upload: vi.fn(),
    download: vi.fn(),
    delete: vi.fn(),
    getSignedUrl: vi.fn(),
    getSignedUploadUrl: vi.fn(),
  }
  const mockSearch = {
    index: vi.fn(),
    search: vi.fn(),
    delete: vi.fn(),
    bulkIndex: vi.fn(),
  }

  it('getResource should return resource data for active resource', async () => {
    const { db, addResult } = createMockDb()
    addResult([
      {
        id: 'res-1',
        packageId: 'pkg-1',
        url: 'https://example.com/data.csv',
        urlType: 'api',
        format: 'CSV',
        hash: 'sha256:abc',
      },
    ])

    const ctx = buildPipelineContext(db, mockStorage, mockSearch)
    const res = await ctx.getResource('res-1')

    expect(res).toEqual({
      id: 'res-1',
      packageId: 'pkg-1',
      url: 'https://example.com/data.csv',
      urlType: 'api',
      format: 'CSV',
      hash: 'sha256:abc',
    })
  })

  it('getResource should return null when not found', async () => {
    const { db, addResult } = createMockDb()
    addResult([])

    const ctx = buildPipelineContext(db, mockStorage, mockSearch)
    const res = await ctx.getResource('nonexistent')

    expect(res).toBeNull()
  })

  it('updateResourceHash should update hash and lastModified', async () => {
    const { db } = createMockDb()

    const ctx = buildPipelineContext(db, mockStorage, mockSearch)
    await ctx.updateResourceHash('res-1', 'sha256:new')

    expect(db.update).toHaveBeenCalled()
    expect(db.set).toHaveBeenCalled()
  })

  it('getPackageForIndex should return package with resources', async () => {
    const { db, addResult } = createMockDb()
    addResult([
      {
        id: 'pkg-1',
        name: 'test-dataset',
        title: 'Test',
        notes: 'Notes',
        ownerOrg: 'org-1',
      },
    ])
    addResult([
      { id: 'res-1', name: 'data.csv', description: 'A CSV', format: 'CSV' },
      { id: 'res-2', name: 'info.json', description: null, format: 'JSON' },
    ])

    const ctx = buildPipelineContext(db, mockStorage, mockSearch)
    const pkg = await ctx.getPackageForIndex('pkg-1')

    expect(pkg).toEqual({
      id: 'pkg-1',
      name: 'test-dataset',
      title: 'Test',
      notes: 'Notes',
      ownerOrg: 'org-1',
      resources: [
        { id: 'res-1', name: 'data.csv', description: 'A CSV', format: 'CSV' },
        { id: 'res-2', name: 'info.json', description: null, format: 'JSON' },
      ],
    })
  })

  it('getPackageForIndex should return null when package not found', async () => {
    const { db, addResult } = createMockDb()
    addResult([])

    const ctx = buildPipelineContext(db, mockStorage, mockSearch)
    const pkg = await ctx.getPackageForIndex('nonexistent')

    expect(pkg).toBeNull()
  })

  it('should pass storage and search adapters through', () => {
    const { db } = createMockDb()
    const ctx = buildPipelineContext(db, mockStorage, mockSearch)

    expect(ctx.storage).toBe(mockStorage)
    expect(ctx.search).toBe(mockSearch)
  })
})

describe('registerPipelineHandler', () => {
  it('should register handler and call processResource on job', async () => {
    const { db } = createMockDb()
    const mockQueue = {
      enqueue: vi.fn(),
      getStatus: vi.fn(),
      process: vi.fn(),
      stop: vi.fn(),
    }
    const mockStorage = {
      upload: vi.fn(),
      download: vi.fn(),
      delete: vi.fn(),
      getSignedUrl: vi.fn(),
      getSignedUploadUrl: vi.fn(),
    }
    const mockSearch = {
      index: vi.fn(),
      search: vi.fn(),
      delete: vi.fn(),
      bulkIndex: vi.fn(),
    }

    await registerPipelineHandler(db, mockQueue, mockStorage, mockSearch)

    expect(mockQueue.process).toHaveBeenCalledWith(PIPELINE_JOB_TYPE, expect.any(Function))

    // Simulate job processing
    const handler = mockQueue.process.mock.calls[0][1]
    const job = { id: 'job-1', type: 'resource-pipeline', data: { resourceId: 'res-1' } }
    await handler(job)

    expect(processResource).toHaveBeenCalledWith('res-1', expect.any(Object), db)
  })
})
