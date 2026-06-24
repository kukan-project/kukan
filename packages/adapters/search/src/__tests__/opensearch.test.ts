import { describe, it, expect, vi, beforeEach } from 'vitest'
import { errors as osErrors } from '@opensearch-project/opensearch'
import { OpenSearchAdapter } from '../opensearch'

// Mock only the OpenSearch client; keep the real `errors` export so error-type
// classification (instanceof checks) behaves identically to production.
vi.mock('@opensearch-project/opensearch', async (importActual) => {
  const actual = (await importActual()) as typeof import('@opensearch-project/opensearch')
  const mockClient = {
    indices: {
      exists: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    index: vi.fn(),
    search: vi.fn(),
    msearch: vi.fn(),
    mget: vi.fn(),
    get: vi.fn(),
    count: vi.fn(),
    delete: vi.fn(),
    deleteByQuery: vi.fn(),
    bulk: vi.fn(),
    cat: {
      indices: vi.fn(),
    },
  }
  return {
    ...actual,
    Client: vi.fn(function () {
      return mockClient
    }),
    __mockClient: mockClient,
  }
})

interface MockClient {
  indices: {
    exists: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
  }
  index: ReturnType<typeof vi.fn>
  search: ReturnType<typeof vi.fn>
  msearch: ReturnType<typeof vi.fn>
  mget: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  count: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  deleteByQuery: ReturnType<typeof vi.fn>
  bulk: ReturnType<typeof vi.fn>
  cat: {
    indices: ReturnType<typeof vi.fn>
  }
}

// Access the mock client
async function getMockClient(): Promise<MockClient> {
  const mod = await import('@opensearch-project/opensearch')
  return (mod as unknown as { __mockClient: MockClient }).__mockClient
}

describe('OpenSearchAdapter', () => {
  let adapter: OpenSearchAdapter
  let mockClient: MockClient

  beforeEach(async () => {
    vi.clearAllMocks()
    adapter = new OpenSearchAdapter({ endpoint: 'http://localhost:9200' })
    mockClient = await getMockClient()
    // Default: indices do not exist
    mockClient.indices.exists.mockResolvedValue({ body: false })
    mockClient.indices.create.mockResolvedValue({ body: {} })
    // Default: non-empty index (for empty-index detection)
    mockClient.count.mockResolvedValue({ body: { count: 10 } })
  })

  describe('ensureIndex', () => {
    it('should create a single search index with join field', async () => {
      await adapter.ensureIndex()

      expect(mockClient.indices.exists).toHaveBeenCalledTimes(1)
      expect(mockClient.indices.create).toHaveBeenCalledTimes(1)

      const createCall = mockClient.indices.create.mock.calls[0][0]
      expect(createCall.index).toBe('kukan-search')
      const props = createCall.body.mappings.properties
      expect(props.join_field).toEqual({
        type: 'join',
        relations: { package: ['resource', 'content'] },
      })
      // Package fields
      expect(props.title.type).toBe('text')
      expect(props.organization.type).toBe('keyword')
      // Resource fields
      expect(props.description.type).toBe('text')
      expect(props.format.type).toBe('keyword')
      // Content fields
      expect(props.extractedText).toEqual({
        type: 'text',
        analyzer: 'kuromoji_analyzer',
        index_options: 'offsets',
      })
      // Unified name field (text + keyword subfield)
      expect(props.name.type).toBe('text')
      expect(props.name.fields.keyword.type).toBe('keyword')
    })

    it('should skip creation when index already exists', async () => {
      mockClient.indices.exists.mockResolvedValue({ body: true })

      await adapter.ensureIndex()

      expect(mockClient.indices.create).not.toHaveBeenCalled()
    })

    it('should skip re-check within TTL (60s)', async () => {
      await adapter.ensureIndex()
      await adapter.ensureIndex()

      expect(mockClient.indices.exists).toHaveBeenCalledTimes(1)
    })

    it('should re-check after TTL expires', async () => {
      await adapter.ensureIndex()
      expect(mockClient.indices.exists).toHaveBeenCalledTimes(1)

      vi.useFakeTimers()
      vi.setSystemTime(Date.now() + 61_000)

      mockClient.indices.exists.mockResolvedValue({ body: true })
      await adapter.ensureIndex()

      expect(mockClient.indices.exists).toHaveBeenCalledTimes(2)
      expect(mockClient.indices.create).toHaveBeenCalledTimes(1)
      vi.useRealTimers()
    })
  })

  describe('getPackagesDocCount', () => {
    it('should return 0 when packages index is empty', async () => {
      mockClient.indices.exists.mockResolvedValue({ body: true })
      mockClient.count.mockResolvedValue({ body: { count: 0 } })

      const result = await adapter.getPackagesDocCount()
      expect(result).toBe(0)
    })

    it('should return document count', async () => {
      mockClient.indices.exists.mockResolvedValue({ body: true })
      mockClient.count.mockResolvedValue({ body: { count: 42 } })

      const result = await adapter.getPackagesDocCount()
      expect(result).toBe(42)
      expect(mockClient.count).toHaveBeenCalledWith({
        index: 'kukan-search',
        body: { query: { term: { join_field: 'package' } } },
      })
    })

    it('should create missing index before checking', async () => {
      mockClient.indices.exists.mockResolvedValue({ body: false })
      mockClient.indices.create.mockResolvedValue({ body: {} })
      mockClient.count.mockResolvedValue({ body: { count: 0 } })

      const result = await adapter.getPackagesDocCount()
      expect(result).toBe(0)
      expect(mockClient.indices.create).toHaveBeenCalledTimes(1)
    })

    it('should return -1 when count API fails', async () => {
      mockClient.indices.exists.mockResolvedValue({ body: true })
      mockClient.count.mockRejectedValue(new Error('OpenSearch unavailable'))

      const result = await adapter.getPackagesDocCount()
      expect(result).toBe(-1)
    })

    it('should use custom index prefix', async () => {
      const customAdapter = new OpenSearchAdapter({
        endpoint: 'http://localhost:9200',
        indexPrefix: 'test',
      })
      mockClient.indices.exists.mockResolvedValue({ body: false })

      await customAdapter.ensureIndex()

      const existsCalls = mockClient.indices.exists.mock.calls
      expect(existsCalls[0][0].index).toBe('test-search')
    })
  })

  describe('indexPackage', () => {
    it('should index a document to search index with join_field', async () => {
      mockClient.index.mockResolvedValue({ body: {} })

      await adapter.indexPackage({
        id: 'pkg-1',
        name: 'test-dataset',
        title: 'Test Dataset',
      })

      expect(mockClient.index).toHaveBeenCalledWith({
        index: 'kukan-search',
        id: 'pkg-1',
        body: expect.objectContaining({
          id: 'pkg-1',
          name: 'test-dataset',
          join_field: 'package',
        }),
        refresh: 'wait_for',
      })
    })
  })

  describe('indexResource', () => {
    it('should index a resource document with join_field and routing', async () => {
      mockClient.index.mockResolvedValue({ body: {} })

      await adapter.indexResource({
        id: 'res-1',
        packageId: 'pkg-1',
        name: 'data.csv',
        format: 'CSV',
      })

      expect(mockClient.index).toHaveBeenCalledWith({
        index: 'kukan-search',
        id: 'res-1',
        body: expect.objectContaining({
          id: 'res-1',
          packageId: 'pkg-1',
          join_field: { name: 'resource', parent: 'pkg-1' },
        }),
        routing: 'pkg-1',
        refresh: 'wait_for',
      })
    })
  })

  describe('search', () => {
    it('should use single search with has_child for keyword queries', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _id: 'pkg-1',
                _source: { name: 'test', join_field: 'package' },
                _score: 5,
              },
            ],
          },
        },
      })

      const result = await adapter.search({ q: 'test query', offset: 0, limit: 10 })

      expect(mockClient.search).toHaveBeenCalled()
      expect(mockClient.msearch).not.toHaveBeenCalled()
      const callArgs = mockClient.search.mock.calls[0][0]
      expect(callArgs.index).toBe('kukan-search')
      // Should have has_child queries in the bool.should
      const must = callArgs.body.query.bool.must[0].bool.should
      expect(must).toHaveLength(3) // package multi_match, has_child resource, has_child content
      expect(must[1].has_child.type).toBe('resource')
      expect(must[2].has_child.type).toBe('content')
      expect(result.items).toHaveLength(1)
    })

    it('should use single search with match_all for empty query (browse mode)', async () => {
      mockClient.search.mockResolvedValue({
        body: { hits: { total: { value: 0 }, hits: [] } },
      })

      await adapter.search({ q: '', offset: 0, limit: 20 })

      expect(mockClient.search).toHaveBeenCalled()
      const callArgs = mockClient.search.mock.calls[0][0]
      expect(callArgs.index).toBe('kukan-search')
      expect(callArgs.body.query.bool.filter).toEqual(
        expect.arrayContaining([{ term: { join_field: 'package' } }])
      )
      expect(callArgs.body.query.bool.must).toEqual([{ match_all: {} }])
    })

    describe('backend availability mapping', () => {
      // Minimal ApiResponse meta for constructing OpenSearch client errors.
      const meta = (statusCode: number) =>
        ({
          body: {},
          statusCode,
          headers: {},
          warnings: null,
          meta: {},
        }) as unknown as ConstructorParameters<typeof osErrors.ResponseError>[0]

      it('maps an OpenSearch timeout to ServiceUnavailableError (503)', async () => {
        mockClient.search.mockRejectedValue(new osErrors.TimeoutError('timed out', meta(0)))
        await expect(adapter.search({ q: 'x' })).rejects.toMatchObject({
          status: 503,
          code: 'SERVICE_UNAVAILABLE',
        })
      })

      it('maps a 429 circuit-breaker response to ServiceUnavailableError (503)', async () => {
        mockClient.search.mockRejectedValue(new osErrors.ResponseError(meta(429)))
        await expect(adapter.search({ q: 'x' })).rejects.toMatchObject({ status: 503 })
      })

      it('does NOT mask a 4xx bad-query response (propagates as-is)', async () => {
        const badQuery = new osErrors.ResponseError(meta(400))
        mockClient.search.mockRejectedValue(badQuery)
        await expect(adapter.search({ q: 'x' })).rejects.toBe(badQuery)
      })

      it('does NOT mask an unexpected error such as a parsing bug', async () => {
        const bug = new TypeError('cannot read property of undefined')
        mockClient.search.mockRejectedValue(bug)
        await expect(adapter.search({ q: 'x' })).rejects.toBe(bug)
      })

      it('maps a connection failure during ensureIndex() to 503', async () => {
        // A down cluster throws at indices.exists() (the first call), before client.search().
        mockClient.indices.exists.mockRejectedValue(
          new osErrors.ConnectionError('connection refused', meta(0))
        )
        await expect(adapter.search({ q: 'x' })).rejects.toMatchObject({ status: 503 })
        expect(mockClient.search).not.toHaveBeenCalled()
      })
    })

    it('should merge content matches into matchedResources via inner_hits', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _id: 'pkg-1',
                _source: { name: 'population', join_field: 'package' },
                _score: 5,
                inner_hits: {
                  resource: { hits: { hits: [] } },
                  content_hits: {
                    hits: {
                      hits: [
                        {
                          _id: 'chunk-res1-0',
                          _source: { resourceId: 'res-1' },
                          _score: 3,
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      })

      // mget for resource metadata (content-only match needs name/format)
      mockClient.mget.mockResolvedValueOnce({
        body: {
          docs: [{ _id: 'res-1', found: true, _source: { name: 'data.csv', format: 'CSV' } }],
        },
      })

      const result = await adapter.search({ q: '人口', offset: 0, limit: 10 })

      expect(result.items).toHaveLength(1)
      expect(result.items[0].matchedResources).toHaveLength(1)
      expect(result.items[0].matchedResources![0]).toEqual(
        expect.objectContaining({
          id: 'res-1',
          matchSource: 'content',
          _contentDocId: 'chunk-res1-0',
        })
      )
    })

    it('should apply organization filter', async () => {
      mockClient.search.mockResolvedValue({
        body: { hits: { total: { value: 0 }, hits: [] } },
      })

      await adapter.search({ q: '', filters: { organizations: ['test-org'] } })

      const callArgs = mockClient.search.mock.calls[0][0]
      expect(callArgs.body.query.bool.filter).toEqual(
        expect.arrayContaining([{ terms: { organization: ['test-org'] } }])
      )
    })

    it('should include aggregations when facets=true', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: { total: { value: 0 }, hits: [] },
          aggregations: {
            organizations: { buckets: [{ key: 'org-a', doc_count: 5 }] },
            tags: { buckets: [] },
            formats: { buckets: [] },
            licenses: { buckets: [] },
            groups: { buckets: [] },
          },
        },
      })

      const result = await adapter.search({ q: '', facets: true })

      expect(result.facets?.organizations).toEqual([{ name: 'org-a', count: 5 }])
    })

    describe('sort', () => {
      beforeEach(() => {
        mockClient.search.mockResolvedValue({
          body: { hits: { total: { value: 0 }, hits: [] } },
        })
      })

      it('should sort by updated DESC when browsing', async () => {
        await adapter.search({ q: '' })
        const callArgs = mockClient.search.mock.calls[0][0]
        expect(callArgs.body.sort).toEqual([{ updated: { order: 'desc' } }])
      })

      it('should sort by specified field', async () => {
        await adapter.search({ q: '', sortBy: 'created', sortOrder: 'asc' })
        const callArgs = mockClient.search.mock.calls[0][0]
        expect(callArgs.body.sort).toEqual([{ created: { order: 'asc' } }])
      })
    })
  })

  describe('deletePackage', () => {
    it('should delete children via deleteByQuery then delete the package', async () => {
      mockClient.deleteByQuery.mockResolvedValue({ body: {} })
      mockClient.delete.mockResolvedValue({ body: {} })

      await adapter.deletePackage('pkg-1')

      // First: deleteByQuery for children
      expect(mockClient.deleteByQuery).toHaveBeenCalledWith({
        index: 'kukan-search',
        body: {
          query: {
            bool: {
              should: [
                { parent_id: { type: 'resource', id: 'pkg-1' } },
                { parent_id: { type: 'content', id: 'pkg-1' } },
              ],
              minimum_should_match: 1,
            },
          },
        },
        routing: 'pkg-1',
        refresh: true,
      })
      // Then: delete the package doc itself
      expect(mockClient.delete).toHaveBeenCalledWith({
        index: 'kukan-search',
        id: 'pkg-1',
        refresh: 'wait_for',
      })
    })

    it('should ignore 404 errors', async () => {
      mockClient.deleteByQuery.mockRejectedValue({ statusCode: 404 })
      mockClient.delete.mockRejectedValue({ statusCode: 404 })
      await expect(adapter.deletePackage('nonexistent')).resolves.toBeUndefined()
    })
  })

  describe('deleteResource', () => {
    it('should delete from search index using deleteByQuery', async () => {
      mockClient.deleteByQuery.mockResolvedValue({ body: {} })

      await adapter.deleteResource('res-1')

      expect(mockClient.deleteByQuery).toHaveBeenCalledWith({
        index: 'kukan-search',
        body: {
          query: {
            bool: {
              filter: [{ term: { _id: 'res-1' } }, { term: { join_field: 'resource' } }],
            },
          },
        },
        refresh: true,
      })
    })
  })

  describe('bulkIndexPackages', () => {
    it('should bulk index to search index with join_field', async () => {
      mockClient.bulk.mockResolvedValue({ body: { errors: false, items: [] } })

      await adapter.bulkIndexPackages([
        { id: 'pkg-1', name: 'dataset-1' },
        { id: 'pkg-2', name: 'dataset-2' },
      ])

      expect(mockClient.bulk).toHaveBeenCalledWith({
        body: [
          { index: { _index: 'kukan-search', _id: 'pkg-1' } },
          expect.objectContaining({ id: 'pkg-1', join_field: 'package' }),
          { index: { _index: 'kukan-search', _id: 'pkg-2' } },
          expect.objectContaining({ id: 'pkg-2', join_field: 'package' }),
        ],
        refresh: 'wait_for',
      })
    })

    it('should skip empty array', async () => {
      await adapter.bulkIndexPackages([])
      expect(mockClient.bulk).not.toHaveBeenCalled()
    })
  })

  describe('bulkIndexResources', () => {
    it('should bulk index to search index with join_field and routing', async () => {
      mockClient.bulk.mockResolvedValue({ body: { errors: false, items: [] } })

      await adapter.bulkIndexResources([
        { id: 'res-1', packageId: 'pkg-1', name: 'data.csv' },
        { id: 'res-2', packageId: 'pkg-1', name: 'data.json' },
      ])

      expect(mockClient.bulk).toHaveBeenCalledWith({
        body: [
          { index: { _index: 'kukan-search', _id: 'res-1', routing: 'pkg-1' } },
          expect.objectContaining({
            id: 'res-1',
            packageId: 'pkg-1',
            join_field: { name: 'resource', parent: 'pkg-1' },
          }),
          { index: { _index: 'kukan-search', _id: 'res-2', routing: 'pkg-1' } },
          expect.objectContaining({
            id: 'res-2',
            packageId: 'pkg-1',
            join_field: { name: 'resource', parent: 'pkg-1' },
          }),
        ],
        refresh: 'wait_for',
      })
    })
  })

  describe('highlight sanitization', () => {
    it('should sanitize XSS in highlighted title', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _id: 'pkg-1',
                _source: { name: 'test', join_field: 'package' },
                _score: 5,
                highlight: {
                  title: ['<script>alert(1)</script><mark>test</mark>'],
                  notes: ['<img onerror=alert(1)><mark>note</mark>'],
                },
              },
            ],
          },
        },
      })

      const result = await adapter.search({ q: 'test' })

      // Script and img tags should be stripped, only <mark> preserved
      expect(result.items[0].highlightedTitle).toBe('alert(1)<mark>test</mark>')
      expect(result.items[0].highlightedNotes).toBe('<mark>note</mark>')
    })

    it('should strip attributes from mark tags to prevent XSS', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _id: 'pkg-1',
                _source: { name: 'test', join_field: 'package' },
                _score: 5,
                highlight: {
                  title: ['<mark onmouseover="alert(1)">test</mark>'],
                },
              },
            ],
          },
        },
      })

      const result = await adapter.search({ q: 'test' })

      expect(result.items[0].highlightedTitle).toBe('<mark>test</mark>')
    })

    it('should sanitize XSS in resource highlight snippets via inner_hits', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _id: 'pkg-1',
                _source: { name: 'test', join_field: 'package' },
                _score: 5,
                inner_hits: {
                  resource: {
                    hits: {
                      hits: [
                        {
                          _id: 'res-1',
                          _source: { id: 'res-1', packageId: 'pkg-1', name: 'data.csv' },
                          _score: 3,
                          highlight: {
                            name: ['<script>x</script><mark>data</mark>.csv'],
                          },
                        },
                      ],
                    },
                  },
                  content_hits: {
                    hits: {
                      hits: [
                        {
                          _id: 'chunk-res1-0',
                          _source: { resourceId: 'res-1' },
                          _score: 2,
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      })

      const result = await adapter.search({ q: 'data' })

      const matched = result.items[0].matchedResources![0]
      expect(matched.highlightedName).toBe('x<mark>data</mark>.csv')
      // Content snippets are now fetched lazily via fetchContentHighlights
      expect(matched._contentDocId).toBe('chunk-res1-0')
    })
  })

  describe('getDocument', () => {
    it('should return document source by ID using search with type filter', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            hits: [{ _id: 'pkg-1', _source: { name: 'test', title: 'Test' } }],
          },
        },
      })

      const doc = await adapter.getDocument('packages', 'pkg-1')

      expect(mockClient.search).toHaveBeenCalledWith({
        index: 'kukan-search',
        body: {
          size: 1,
          query: {
            bool: {
              filter: [{ term: { _id: 'pkg-1' } }, { term: { join_field: 'package' } }],
            },
          },
        },
      })
      expect(doc).toEqual({ name: 'test', title: 'Test' })
    })

    it('should return null for non-existent document', async () => {
      mockClient.search.mockResolvedValue({
        body: { hits: { hits: [] } },
      })

      const doc = await adapter.getDocument('resources', 'nonexistent')

      expect(doc).toBeNull()
    })

    it('should use correct join_field type for each index', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: { hits: [{ _id: 'res-1', _source: { name: 'data.csv' } }] },
        },
      })

      await adapter.getDocument('resources', 'res-1')

      expect(mockClient.search).toHaveBeenCalledWith({
        index: 'kukan-search',
        body: {
          size: 1,
          query: {
            bool: {
              filter: [{ term: { _id: 'res-1' } }, { term: { join_field: 'resource' } }],
            },
          },
        },
      })
    })
  })

  describe('browseDocuments', () => {
    it('should return paginated documents with join_field filter', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            total: { value: 50 },
            hits: [
              { _id: 'pkg-1', _source: { name: 'alpha', title: 'Alpha' } },
              { _id: 'pkg-2', _source: { name: 'beta', title: 'Beta' } },
            ],
          },
        },
      })

      const result = await adapter.browseDocuments('packages', { offset: 0, limit: 20 })

      expect(result).not.toBeNull()
      expect(result!.items).toHaveLength(2)
      expect(result!.total).toBe(50)
      expect(result!.items[0].id).toBe('pkg-1')
      expect(result!.items[0].source.name).toBe('alpha')

      const callArgs = mockClient.search.mock.calls[0][0]
      expect(callArgs.index).toBe('kukan-search')
      expect(callArgs.body.query).toEqual({ term: { join_field: 'package' } })
    })

    it('should exclude extractedText from contents browse', async () => {
      mockClient.search.mockResolvedValue({
        body: { hits: { total: { value: 0 }, hits: [] } },
      })

      await adapter.browseDocuments('contents', { offset: 0, limit: 10 })

      const callArgs = mockClient.search.mock.calls[0][0]
      expect(callArgs.body._source).toEqual({ excludes: ['extractedText'] })
    })

    it('should search with correct fields per index and join_field filter', async () => {
      mockClient.search.mockResolvedValue({
        body: { hits: { total: { value: 0 }, hits: [] } },
      })

      await adapter.browseDocuments('resources', { q: 'test', offset: 0 })

      const callArgs = mockClient.search.mock.calls[0][0]
      expect(callArgs.index).toBe('kukan-search')
      expect(callArgs.body.query.bool.filter).toEqual([{ term: { join_field: 'resource' } }])
      expect(callArgs.body.query.bool.must[0].multi_match).toEqual(
        expect.objectContaining({
          query: 'test',
          fields: ['name', 'description'],
        })
      )
    })

    it('should cap limit at 100', async () => {
      mockClient.search.mockResolvedValue({
        body: { hits: { total: { value: 0 }, hits: [] } },
      })

      await adapter.browseDocuments('packages', { limit: 500 })

      const callArgs = mockClient.search.mock.calls[0][0]
      expect(callArgs.body.size).toBe(100)
    })
  })

  describe('indexContent', () => {
    it('should use resourceId_chunk_N as doc id with join_field and routing', async () => {
      mockClient.index.mockResolvedValue({ body: {} })

      await adapter.indexContent({
        resourceId: 'res-1',
        packageId: 'pkg-1',
        extractedText: 'some text content',
        contentType: 'text',
        chunkIndex: 0,
      })

      expect(mockClient.index).toHaveBeenCalledWith({
        index: 'kukan-search',
        id: 'res-1_chunk_0',
        body: expect.objectContaining({
          resourceId: 'res-1',
          packageId: 'pkg-1',
          chunkIndex: 0,
          join_field: { name: 'content', parent: 'pkg-1' },
        }),
        routing: 'pkg-1',
        refresh: 'wait_for',
      })
    })

    it('should increment chunk index in doc id', async () => {
      mockClient.index.mockResolvedValue({ body: {} })

      await adapter.indexContent({
        resourceId: 'res-1',
        packageId: 'pkg-1',
        extractedText: 'chunk 2 content',
        contentType: 'tabular',
        chunkIndex: 1,
      })

      expect(mockClient.index).toHaveBeenCalledWith({
        index: 'kukan-search',
        id: 'res-1_chunk_1',
        body: expect.objectContaining({
          resourceId: 'res-1',
          chunkIndex: 1,
          join_field: { name: 'content', parent: 'pkg-1' },
        }),
        routing: 'pkg-1',
        refresh: 'wait_for',
      })
    })
  })

  describe('deleteContent', () => {
    it('should delete all chunks by resourceId and join_field using deleteByQuery', async () => {
      mockClient.deleteByQuery.mockResolvedValue({ body: {} })

      await adapter.deleteContent('res-1')

      expect(mockClient.deleteByQuery).toHaveBeenCalledWith({
        index: 'kukan-search',
        body: {
          query: {
            bool: {
              filter: [{ term: { resourceId: 'res-1' } }, { term: { join_field: 'content' } }],
            },
          },
        },
        refresh: true,
      })
    })
  })

  describe('deleteAllPackages', () => {
    it('should delete all package documents using deleteByQuery', async () => {
      mockClient.deleteByQuery.mockResolvedValue({ body: {} })

      await adapter.deleteAllPackages()

      expect(mockClient.deleteByQuery).toHaveBeenCalledWith({
        index: 'kukan-search',
        body: { query: { term: { join_field: 'package' } } },
        refresh: true,
      })
    })

    it('should ignore 404 when index does not exist', async () => {
      mockClient.deleteByQuery.mockRejectedValue({ statusCode: 404 })

      await expect(adapter.deleteAllPackages()).resolves.toBeUndefined()
    })
  })

  describe('deleteAllResources', () => {
    it('should delete all resource documents using deleteByQuery', async () => {
      mockClient.deleteByQuery.mockResolvedValue({ body: {} })

      await adapter.deleteAllResources()

      expect(mockClient.deleteByQuery).toHaveBeenCalledWith({
        index: 'kukan-search',
        body: { query: { term: { join_field: 'resource' } } },
        refresh: true,
      })
    })
  })

  describe('deleteAllContents', () => {
    it('should delete all content documents using deleteByQuery', async () => {
      mockClient.deleteByQuery.mockResolvedValue({ body: {} })

      await adapter.deleteAllContents()

      expect(mockClient.deleteByQuery).toHaveBeenCalledWith({
        index: 'kukan-search',
        body: { query: { term: { join_field: 'content' } } },
        refresh: true,
      })
    })
  })

  describe('content-only match (inner_hits + mget enrichment)', () => {
    it('should fetch resource metadata for content-only matches via mget', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _id: 'pkg-1',
                _source: { name: 'my-dataset', title: 'My Dataset', join_field: 'package' },
                _score: 3,
                inner_hits: {
                  resource: { hits: { hits: [] } },
                  content_hits: {
                    hits: {
                      hits: [
                        {
                          _id: 'chunk-res1-0',
                          _source: { resourceId: 'res-1' },
                          _score: 2,
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      })

      // mget for resource metadata (content-only match)
      mockClient.mget.mockResolvedValueOnce({
        body: {
          docs: [
            {
              _id: 'res-1',
              found: true,
              _source: { name: 'data.csv', description: 'Test data', format: 'CSV' },
            },
          ],
        },
      })

      const result = await adapter.search({ q: 'keyword' })

      // Should have fetched resource metadata with routing
      expect(mockClient.mget).toHaveBeenCalledWith({
        index: 'kukan-search',
        body: { docs: [{ _id: 'res-1', routing: 'pkg-1' }] },
      })
      expect(result.items).toHaveLength(1)
      expect(result.items[0].matchedResources).toHaveLength(1)

      const mr = result.items[0].matchedResources![0]
      expect(mr.name).toBe('data.csv')
      expect(mr.description).toBe('Test data')
      expect(mr.format).toBe('CSV')
      expect(mr.matchSource).toBe('content')
      expect(mr._contentDocId).toBe('chunk-res1-0')
    })

    it('should not duplicate resources matched by both metadata and content', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _id: 'pkg-1',
                _source: { name: 'test', join_field: 'package' },
                _score: 5,
                inner_hits: {
                  resource: {
                    hits: {
                      hits: [
                        {
                          _id: 'res-1',
                          _source: { id: 'res-1', packageId: 'pkg-1', name: 'data.csv' },
                          _score: 3,
                          highlight: { name: ['<mark>data</mark>.csv'] },
                        },
                      ],
                    },
                  },
                  content_hits: {
                    hits: {
                      hits: [
                        {
                          _id: 'chunk-res1-0',
                          _source: { resourceId: 'res-1' },
                          _score: 2,
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      })

      const result = await adapter.search({ q: 'data', offset: 0, limit: 10 })

      // Should have 1 matched resource (not duplicated)
      expect(result.items[0].matchedResources).toHaveLength(1)
      const mr = result.items[0].matchedResources![0]
      // Both metadata and content matched — matchSource upgraded to 'content'
      expect(mr.matchSource).toBe('content')
      expect(mr._contentDocId).toBe('chunk-res1-0')
      // Metadata highlight still present
      expect(mr.highlightedName).toBe('<mark>data</mark>.csv')
    })
  })

  describe('fetchContentHighlights', () => {
    it('should return highlights keyed by chunk doc ID', async () => {
      mockClient.search.mockResolvedValueOnce({
        body: {
          hits: {
            hits: [
              { _id: 'chunk-1', highlight: { extractedText: ['<mark>test</mark> data'] } },
              { _id: 'chunk-2', highlight: { extractedText: ['more <mark>test</mark>'] } },
            ],
          },
        },
      })

      const result = await adapter.fetchContentHighlights(['chunk-1', 'chunk-2'], 'test')

      expect(result).toEqual({
        'chunk-1': '<mark>test</mark> data',
        'chunk-2': 'more <mark>test</mark>',
      })

      // Verify it uses kukan-search with content type filter
      const callArgs = mockClient.search.mock.calls[0][0]
      expect(callArgs.index).toBe('kukan-search')
      expect(callArgs.body.query.bool.filter).toEqual(
        expect.arrayContaining([{ term: { join_field: 'content' } }])
      )
    })

    it('should return empty object for empty input', async () => {
      const result = await adapter.fetchContentHighlights([], 'test')
      expect(result).toEqual({})
      expect(mockClient.search).not.toHaveBeenCalled()
    })

    it('should sanitize XSS in highlight snippets', async () => {
      mockClient.search.mockResolvedValueOnce({
        body: {
          hits: {
            hits: [
              {
                _id: 'chunk-1',
                highlight: {
                  extractedText: ['<script>alert(1)</script><mark>data</mark>'],
                },
              },
            ],
          },
        },
      })

      const result = await adapter.fetchContentHighlights(['chunk-1'], 'data')
      expect(result['chunk-1']).toBe('alert(1)<mark>data</mark>')
    })

    it('should return empty object on OpenSearch error', async () => {
      mockClient.search.mockRejectedValueOnce(new Error('connection refused'))

      const result = await adapter.fetchContentHighlights(['chunk-1'], 'test')
      expect(result).toEqual({})
    })

    it('should skip chunks without highlight fragments', async () => {
      mockClient.search.mockResolvedValueOnce({
        body: {
          hits: {
            hits: [
              { _id: 'chunk-1', highlight: { extractedText: ['<mark>found</mark>'] } },
              { _id: 'chunk-2', highlight: {} },
              { _id: 'chunk-3' },
            ],
          },
        },
      })

      const result = await adapter.fetchContentHighlights(
        ['chunk-1', 'chunk-2', 'chunk-3'],
        'found'
      )
      expect(result).toEqual({ 'chunk-1': '<mark>found</mark>' })
    })

    it('should enforce caller visibility via has_parent on the parent package', async () => {
      mockClient.search.mockResolvedValueOnce({ body: { hits: { hits: [] } } })

      await adapter.fetchContentHighlights(['chunk-1'], 'secret', {
        excludePrivate: true,
        allowPrivateOrgIds: ['org-1'],
      })

      const callArgs = mockClient.search.mock.calls[0][0]
      const filter = callArgs.body.query.bool.filter
      const hasParent = filter.find((f: Record<string, unknown>) => 'has_parent' in f)
      expect(hasParent).toBeDefined()
      expect(hasParent.has_parent.parent_type).toBe('package')
      // The parent query must carry the private/owner_org visibility clause.
      const parentFilter = hasParent.has_parent.query.bool.filter
      expect(JSON.stringify(parentFilter)).toContain('owner_org_id')
      expect(JSON.stringify(parentFilter)).toContain('private')
    })
  })

  describe('search content + resource overlap', () => {
    it('should attach _contentDocId when resource matches both metadata and content', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _id: 'pkg-1',
                _source: { name: 'test-pkg', join_field: 'package' },
                _score: 5,
                inner_hits: {
                  // Resource metadata match
                  resource: {
                    hits: {
                      hits: [
                        {
                          _id: 'res-1',
                          _source: { id: 'res-1', packageId: 'pkg-1', name: 'data.csv' },
                          _score: 3,
                          highlight: { name: ['<mark>data</mark>.csv'] },
                        },
                      ],
                    },
                  },
                  // Content match for same resource
                  content_hits: {
                    hits: {
                      hits: [
                        {
                          _id: 'chunk-res1-0',
                          _source: { resourceId: 'res-1' },
                          _score: 2,
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      })

      const result = await adapter.search({ q: 'data', offset: 0, limit: 10 })

      // Should have 1 matched resource (not duplicated)
      expect(result.items[0].matchedResources).toHaveLength(1)
      const mr = result.items[0].matchedResources![0]
      // Both metadata and content matched — matchSource upgraded to 'content'
      expect(mr.matchSource).toBe('content')
      expect(mr._contentDocId).toBe('chunk-res1-0')
      // Metadata highlight still present
      expect(mr.highlightedName).toBe('<mark>data</mark>.csv')
    })
  })

  describe('sumResourceCount', () => {
    it('should return resource count using has_parent query', async () => {
      mockClient.indices.exists.mockResolvedValue({ body: true })
      mockClient.count.mockResolvedValue({ body: { count: 5 } })

      const result = await adapter.sumResourceCount()

      expect(mockClient.count).toHaveBeenCalledWith({
        index: 'kukan-search',
        body: {
          query: {
            bool: {
              filter: [
                { term: { join_field: 'resource' } },
                {
                  has_parent: {
                    parent_type: 'package',
                    query: {
                      bool: { must: [{ match_all: {} }] },
                    },
                  },
                },
              ],
            },
          },
        },
      })
      expect(result).toBe(5)
    })

    it('should return 0 when count returns 0', async () => {
      mockClient.indices.exists.mockResolvedValue({ body: true })
      mockClient.count.mockResolvedValue({ body: { count: 0 } })

      const result = await adapter.sumResourceCount()

      expect(result).toBe(0)
    })

    it('should pass query and filters to has_parent', async () => {
      mockClient.indices.exists.mockResolvedValue({ body: true })
      mockClient.count.mockResolvedValue({ body: { count: 3 } })

      await adapter.sumResourceCount({
        q: 'population',
        filters: { organizations: ['tokyo'] },
      })

      const countCall = mockClient.count.mock.calls[0][0]
      expect(countCall.index).toBe('kukan-search')
      const parentQuery = countCall.body.query.bool.filter[1].has_parent.query.bool
      expect(parentQuery.must).toBeDefined()
      expect(parentQuery.filter).toEqual(
        expect.arrayContaining([{ terms: { organization: ['tokyo'] } }])
      )
    })
  })

  describe('getContentChunks', () => {
    it('should return chunks sorted by chunkIndex', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            hits: [
              { _id: 'res-1_chunk_0', _source: { chunkIndex: 0, chunkSize: 500 } },
              { _id: 'res-1_chunk_1', _source: { chunkIndex: 1, chunkSize: 300 } },
            ],
          },
        },
      })

      const chunks = await adapter.getContentChunks('res-1')

      expect(mockClient.search).toHaveBeenCalledWith({
        index: 'kukan-search',
        body: expect.objectContaining({
          query: {
            bool: {
              filter: [{ term: { resourceId: 'res-1' } }, { term: { join_field: 'content' } }],
            },
          },
          sort: [{ chunkIndex: { order: 'asc' } }],
        }),
      })
      expect(chunks).toEqual([
        { id: 'res-1_chunk_0', chunkIndex: 0, chunkSize: 500 },
        { id: 'res-1_chunk_1', chunkIndex: 1, chunkSize: 300 },
      ])
    })

    it('should return empty array when no chunks found', async () => {
      mockClient.search.mockResolvedValue({ body: { hits: { hits: [] } } })

      const chunks = await adapter.getContentChunks('nonexistent')

      expect(chunks).toEqual([])
    })
  })

  describe('browseContentsByResource', () => {
    it('should group chunks by resourceId with metadata', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          aggregations: {
            by_resource: {
              buckets: [
                {
                  key: 'res-1',
                  doc_count: 3,
                  sample: {
                    hits: { hits: [{ _source: { packageId: 'pkg-1', contentType: 'tabular' } }] },
                  },
                  total_size: { value: 3000 },
                },
                {
                  key: 'res-2',
                  doc_count: 1,
                  sample: {
                    hits: { hits: [{ _source: { packageId: 'pkg-1', contentType: 'text' } }] },
                  },
                  total_size: { value: 500 },
                },
              ],
            },
          },
        },
      })

      mockClient.mget.mockResolvedValue({
        body: {
          docs: [
            { _id: 'res-1', found: true, _source: { name: 'data.csv', format: 'CSV' } },
            { _id: 'res-2', found: true, _source: { name: 'notes.txt', format: 'TXT' } },
          ],
        },
      })

      const result = await adapter.browseContentsByResource({})

      // Verify search uses kukan-search with content type filter
      const searchCall = mockClient.search.mock.calls[0][0]
      expect(searchCall.index).toBe('kukan-search')
      expect(searchCall.body.query.bool.filter).toEqual([{ term: { join_field: 'content' } }])

      // Verify mget uses kukan-search with routing
      expect(mockClient.mget).toHaveBeenCalledWith({
        index: 'kukan-search',
        body: {
          docs: [
            { _id: 'res-1', routing: 'pkg-1' },
            { _id: 'res-2', routing: 'pkg-1' },
          ],
        },
      })

      expect(result.total).toBe(2)
      expect(result.items[0]).toEqual({
        resourceId: 'res-1',
        packageId: 'pkg-1',
        contentType: 'tabular',
        chunks: 3,
        totalSize: 3000,
        resourceName: 'data.csv',
        resourceFormat: 'CSV',
      })
      expect(result.items[1].resourceName).toBe('notes.txt')
    })

    it('should support pagination', async () => {
      const buckets = Array.from({ length: 5 }, (_, i) => ({
        key: `res-${i}`,
        doc_count: 1,
        sample: { hits: { hits: [{ _source: { packageId: 'pkg-1', contentType: 'text' } }] } },
        total_size: { value: 100 },
      }))

      mockClient.search.mockResolvedValue({
        body: { aggregations: { by_resource: { buckets } } },
      })
      mockClient.mget.mockResolvedValue({ body: { docs: [] } })

      const result = await adapter.browseContentsByResource({ offset: 2, limit: 2 })

      expect(result.total).toBe(5)
      expect(result.items).toHaveLength(2)
      expect(result.items[0].resourceId).toBe('res-2')
      expect(result.offset).toBe(2)
      expect(result.limit).toBe(2)
    })

    it('should support search query', async () => {
      mockClient.search.mockResolvedValue({
        body: { aggregations: { by_resource: { buckets: [] } } },
      })

      await adapter.browseContentsByResource({ q: 'population' })

      const searchCall = mockClient.search.mock.calls[0][0]
      expect(searchCall.body.query.bool.must).toEqual({
        match: { extractedText: { query: 'population', operator: 'and' } },
      })
      expect(searchCall.body.query.bool.filter).toEqual([{ term: { join_field: 'content' } }])
    })
  })
})
