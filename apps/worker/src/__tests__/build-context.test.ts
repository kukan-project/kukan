import { describe, it, expect, vi } from 'vitest'
import { buildPipelineContext } from '../pipeline/build-context'

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
}))

// Mock drizzle-orm
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col, val) => ({ col, val, type: 'eq' })),
  and: vi.fn((...conditions) => ({ conditions, type: 'and' })),
  sql: Object.assign((strings: TemplateStringsArray) => strings.join(''), { raw: vi.fn() }),
}))

/**
 * Create a mock DB that supports chaining and thenable resolution.
 * Results are consumed in order via callIndex, matching the sequential
 * construction of query chains (even inside Promise.all).
 */
function createMockDb() {
  const results: unknown[][] = []
  let callIndex = 0

  function makeThenable(result: unknown[]) {
    const obj = {
      limit: vi.fn(() => makeThenable(result)),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(result)),
    }
    return obj
  }

  const self = {
    select: vi.fn(() => self),
    from: vi.fn(() => self),
    innerJoin: vi.fn(() => self),
    where: vi.fn(() => {
      const result = results[callIndex++] ?? []
      return makeThenable(result)
    }),
    limit: vi.fn(() => {
      const result = results[callIndex++] ?? []
      return makeThenable(result)
    }),
    update: vi.fn(() => self),
    set: vi.fn(() => self),
  }

  return {
    db: self as unknown as Parameters<typeof buildPipelineContext>[0],
    addResult: (result: unknown[]) => results.push(result),
  }
}

const mockStorage = {
  upload: vi.fn(),
  download: vi.fn(),
  downloadRange: vi.fn(),
  delete: vi.fn(),
  getSignedUrl: vi.fn(),
  getSignedUploadUrl: vi.fn(),
}

describe('buildPipelineContext', () => {
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

    const ctx = buildPipelineContext(db, mockStorage)
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

    const ctx = buildPipelineContext(db, mockStorage)
    const res = await ctx.getResource('nonexistent')

    expect(res).toBeNull()
  })

  it('updateResourceHashAndSize should update hash, size, and lastModified', async () => {
    const { db } = createMockDb()

    const ctx = buildPipelineContext(db, mockStorage)
    await ctx.updateResourceHashAndSize('res-1', { hash: 'sha256:new', size: 1024 })

    expect(db.update).toHaveBeenCalled()
    expect(db.set).toHaveBeenCalled()
  })

  it('should pass storage adapter through', () => {
    const { db } = createMockDb()
    const ctx = buildPipelineContext(db, mockStorage)

    expect(ctx.storage).toBe(mockStorage)
  })

  it('deleteContent should call search.deleteContent when search is provided', async () => {
    const { db } = createMockDb()
    const mockSearch = { deleteContent: vi.fn() }
    const ctx = buildPipelineContext(db, mockStorage, mockSearch as never)

    await ctx.deleteContent('res-1')

    expect(mockSearch.deleteContent).toHaveBeenCalledWith('res-1')
  })

  it('deleteContent should be no-op when search is not provided', async () => {
    const { db } = createMockDb()
    const ctx = buildPipelineContext(db, mockStorage)

    await expect(ctx.deleteContent('res-1')).resolves.toBeUndefined()
  })
})
