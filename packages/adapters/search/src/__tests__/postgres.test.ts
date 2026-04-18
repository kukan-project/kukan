import { describe, it, expect, vi } from 'vitest'
import { PostgresSearchAdapter } from '../postgres'
import type { Database } from '@kukan/db'

/**
 * Proxy-based mock that resolves to `result` when awaited,
 * simulating drizzle's fluent query builder (.from().where().limit() etc.).
 */
function queryChain(result: unknown) {
  const handler: ProxyHandler<object> = {
    get(_, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve(result)
      }
      return (..._args: unknown[]) => new Proxy({}, handler)
    },
  }
  return new Proxy({}, handler)
}

/**
 * Mock Database whose sequential `db.select()` calls
 * resolve to values from `selectResults`.
 *
 * Call order for search({ q: '', facets: false }):
 *   0: count query
 *   1: data rows
 *   2: tags             (skipped if no rows)
 *
 * With q (non-empty):
 *   2: tags, 3: matchedResources  (parallel via Promise.all)
 *
 * With facets:
 *   +0: org, +1: tags, +2: formats, +3: licenses, +4: groups
 */
function createMockDb(selectResults: unknown[][]) {
  let idx = 0
  return {
    select: vi.fn(() => queryChain(selectResults[idx++] ?? [])),
  } as unknown as Database
}

describe('PostgresSearchAdapter', () => {
  describe('no-op methods', () => {
    const adapter = new PostgresSearchAdapter(createMockDb([]))

    it('indexPackage should be a no-op', async () => {
      await expect(adapter.indexPackage({ id: '1', name: 'test' })).resolves.toBeUndefined()
    })

    it('deletePackage should be a no-op', async () => {
      await expect(adapter.deletePackage('1')).resolves.toBeUndefined()
    })

    it('bulkIndexPackages should be a no-op', async () => {
      await expect(adapter.bulkIndexPackages([{ id: '1', name: 'test' }])).resolves.toBeUndefined()
    })

    it('deleteAllPackages should be a no-op', async () => {
      await expect(adapter.deleteAllPackages()).resolves.toBeUndefined()
    })
  })

  describe('search', () => {
    it('should return formatted items with tags', async () => {
      const db = createMockDb([
        [{ count: 2 }],
        [
          { id: 'p1', name: 'pkg-1', title: 'Package One', notes: null, organization: 'org-a' },
          { id: 'p2', name: 'pkg-2', title: null, notes: 'Notes', organization: null },
        ],
        [
          { packageId: 'p1', tagName: 'env' },
          { packageId: 'p1', tagName: 'health' },
        ],
      ])

      const result = await new PostgresSearchAdapter(db).search({ q: '', offset: 0, limit: 20 })

      expect(result).toEqual({
        items: [
          {
            id: 'p1',
            name: 'pkg-1',
            title: 'Package One',
            notes: undefined,
            organization: 'org-a',
            tags: ['env', 'health'],
          },
          {
            id: 'p2',
            name: 'pkg-2',
            title: undefined,
            notes: 'Notes',
            organization: undefined,
            tags: [],
          },
        ],
        total: 2,
        offset: 0,
        limit: 20,
      })
    })

    it('should include matchedResources when query is present', async () => {
      const db = createMockDb([
        [{ count: 1 }],
        [{ id: 'p1', name: 'pkg-1', title: 'Data', notes: null, organization: 'org-a' }],
        [], // tags
        [{ id: 'r1', packageId: 'p1', name: 'report.csv', description: 'Q1', format: 'CSV' }],
      ])

      const result = await new PostgresSearchAdapter(db).search({ q: 'report' })

      expect(result.items[0].matchedResources).toEqual([
        { id: 'r1', name: 'report.csv', description: 'Q1', format: 'CSV' },
      ])
    })

    it('should not include matchedResources for empty query', async () => {
      const db = createMockDb([
        [{ count: 1 }],
        [{ id: 'p1', name: 'pkg-1', title: null, notes: null, organization: null }],
        [], // tags
      ])

      const result = await new PostgresSearchAdapter(db).search({ q: '' })

      expect(result.items[0].matchedResources).toBeUndefined()
    })

    it('should handle empty results', async () => {
      const db = createMockDb([
        [{ count: 0 }],
        [], // no data rows → tag/resource queries skipped
      ])

      const result = await new PostgresSearchAdapter(db).search({ q: 'nonexistent' })

      expect(result).toEqual({ items: [], total: 0, offset: 0, limit: 20 })
    })

    it('should respect pagination parameters', async () => {
      const db = createMockDb([
        [{ count: 50 }],
        [{ id: 'p1', name: 'pkg-1', title: null, notes: null, organization: null }],
        [], // tags
      ])

      const result = await new PostgresSearchAdapter(db).search({ q: '', offset: 20, limit: 10 })

      expect(result.offset).toBe(20)
      expect(result.limit).toBe(10)
      expect(result.total).toBe(50)
    })

    it('should use default offset=0 and limit=20', async () => {
      const db = createMockDb([[{ count: 0 }], []])

      const result = await new PostgresSearchAdapter(db).search({ q: '' })

      expect(result.offset).toBe(0)
      expect(result.limit).toBe(20)
    })

    it('should group matched resources by package', async () => {
      const db = createMockDb([
        [{ count: 2 }],
        [
          { id: 'p1', name: 'pkg-1', title: null, notes: null, organization: null },
          { id: 'p2', name: 'pkg-2', title: null, notes: null, organization: null },
        ],
        [], // tags
        [
          { id: 'r1', packageId: 'p1', name: 'a.csv', description: null, format: 'CSV' },
          { id: 'r2', packageId: 'p1', name: 'b.csv', description: null, format: 'CSV' },
          { id: 'r3', packageId: 'p2', name: 'c.json', description: null, format: 'JSON' },
        ],
      ])

      const result = await new PostgresSearchAdapter(db).search({ q: 'data' })

      expect(result.items[0].matchedResources).toHaveLength(2)
      expect(result.items[1].matchedResources).toHaveLength(1)
    })
  })

  describe('sort', () => {
    it('should accept sortBy and sortOrder without errors', async () => {
      const db = createMockDb([
        [{ count: 1 }],
        [{ id: 'p1', name: 'pkg-1', title: null, notes: null, organization: null }],
        [], // tags
      ])

      const result = await new PostgresSearchAdapter(db).search({
        q: '',
        sortBy: 'name',
        sortOrder: 'asc',
      })

      expect(result.items).toHaveLength(1)
      expect(result.total).toBe(1)
    })

    it('should accept sortBy created with desc order', async () => {
      const db = createMockDb([
        [{ count: 1 }],
        [{ id: 'p1', name: 'pkg-1', title: null, notes: null, organization: null }],
        [], // tags
      ])

      const result = await new PostgresSearchAdapter(db).search({
        q: '',
        sortBy: 'created',
        sortOrder: 'desc',
      })

      expect(result.items).toHaveLength(1)
    })

    it('should work with sortBy and no explicit sortOrder', async () => {
      const db = createMockDb([
        [{ count: 1 }],
        [{ id: 'p1', name: 'pkg-1', title: null, notes: null, organization: null }],
        [], // tags
      ])

      const result = await new PostgresSearchAdapter(db).search({
        q: '',
        sortBy: 'updated',
      })

      expect(result.items).toHaveLength(1)
    })
  })

  describe('facets', () => {
    it('should compute facets when requested', async () => {
      const db = createMockDb([
        // Main search: count, data, tags
        [{ count: 1 }],
        [{ id: 'p1', name: 'pkg-1', title: null, notes: null, organization: null }],
        [], // tags
        // Facet queries: org, tags, formats, licenses, groups
        [{ name: 'org-a', count: 5 }],
        [
          { name: 'env', count: 3 },
          { name: 'health', count: 1 },
        ],
        [{ name: 'CSV', count: 2 }],
        [{ name: 'cc-by', count: 4 }],
        [], // groups
      ])

      const result = await new PostgresSearchAdapter(db).search({ q: '', facets: true })

      expect(result.facets).toEqual({
        organizations: [{ name: 'org-a', count: 5 }],
        tags: [
          { name: 'env', count: 3 },
          { name: 'health', count: 1 },
        ],
        formats: [{ name: 'CSV', count: 2 }],
        licenses: [{ name: 'cc-by', count: 4 }],
        groups: [],
      })
    })

    it('should not include facets when not requested', async () => {
      const db = createMockDb([[{ count: 0 }], []])

      const result = await new PostgresSearchAdapter(db).search({ q: '' })

      expect(result.facets).toBeUndefined()
    })

    it('should filter out null facet names', async () => {
      const db = createMockDb([
        [{ count: 0 }],
        [], // no rows → skip tags
        // Facet queries
        [
          { name: null, count: 3 },
          { name: 'org-a', count: 5 },
        ],
        [],
        [],
        [],
        [],
      ])

      const result = await new PostgresSearchAdapter(db).search({ q: '', facets: true })

      expect(result.facets!.organizations).toEqual([{ name: 'org-a', count: 5 }])
    })
  })
})
