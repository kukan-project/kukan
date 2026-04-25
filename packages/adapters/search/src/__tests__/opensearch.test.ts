import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenSearchAdapter } from '../opensearch'

// Mock the OpenSearch client
vi.mock('@opensearch-project/opensearch', () => {
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
  }
  return {
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
  })

  describe('ensureIndex', () => {
    it('should create packages, resources, and contents indices', async () => {
      await adapter.ensureIndex()

      expect(mockClient.indices.exists).toHaveBeenCalledTimes(3)
      expect(mockClient.indices.create).toHaveBeenCalledTimes(3)

      const createCalls = mockClient.indices.create.mock.calls
      expect(createCalls[0][0].index).toBe('kukan-packages')
      expect(createCalls[1][0].index).toBe('kukan-resources')
      expect(createCalls[2][0].index).toBe('kukan-contents')
    })

    it('should not include extractedText in resources index', async () => {
      await adapter.ensureIndex()

      const resourcesCreateCall = mockClient.indices.create.mock.calls[1][0]
      const props = resourcesCreateCall.body.mappings.properties
      expect(props.extractedText).toBeUndefined()
      expect(props.name.type).toBe('text')
      expect(props.description.type).toBe('text')
      expect(props.format.type).toBe('keyword')
    })

    it('should create contents index with extractedText field', async () => {
      await adapter.ensureIndex()

      const contentsCreateCall = mockClient.indices.create.mock.calls[2][0]
      const props = contentsCreateCall.body.mappings.properties
      expect(props.extractedText).toEqual({
        type: 'text',
        analyzer: 'kuromoji_analyzer',
        index_options: 'offsets',
      })
      expect(props.contentType.type).toBe('keyword')
      expect(props.packageId.type).toBe('keyword')
    })

    it('should skip creation when indices already exist', async () => {
      mockClient.indices.exists.mockResolvedValue({ body: true })

      await adapter.ensureIndex()

      expect(mockClient.indices.create).not.toHaveBeenCalled()
    })

    it('should only check once (idempotent)', async () => {
      await adapter.ensureIndex()
      await adapter.ensureIndex()

      // 3 calls on first ensureIndex (packages + resources + contents), then 0 on second
      expect(mockClient.indices.exists).toHaveBeenCalledTimes(3)
    })

    it('should use custom index prefix', async () => {
      const customAdapter = new OpenSearchAdapter({
        endpoint: 'http://localhost:9200',
        indexPrefix: 'test',
      })
      mockClient.indices.exists.mockResolvedValue({ body: false })

      await customAdapter.ensureIndex()

      const existsCalls = mockClient.indices.exists.mock.calls
      expect(existsCalls[0][0].index).toBe('test-packages')
      expect(existsCalls[1][0].index).toBe('test-resources')
    })
  })

  describe('indexPackage', () => {
    it('should index a document to packages index', async () => {
      mockClient.index.mockResolvedValue({ body: {} })

      await adapter.indexPackage({
        id: 'pkg-1',
        name: 'test-dataset',
        title: 'Test Dataset',
      })

      expect(mockClient.index).toHaveBeenCalledWith({
        index: 'kukan-packages',
        id: 'pkg-1',
        body: expect.objectContaining({ id: 'pkg-1', name: 'test-dataset' }),
        refresh: 'wait_for',
      })
    })
  })

  describe('indexResource', () => {
    it('should index a resource document', async () => {
      mockClient.index.mockResolvedValue({ body: {} })

      await adapter.indexResource({
        id: 'res-1',
        packageId: 'pkg-1',
        name: 'data.csv',
        format: 'CSV',
      })

      expect(mockClient.index).toHaveBeenCalledWith({
        index: 'kukan-resources',
        id: 'res-1',
        body: expect.objectContaining({
          id: 'res-1',
          packageId: 'pkg-1',
        }),
        refresh: 'wait_for',
      })
    })
  })

  describe('search', () => {
    it('should use msearch for queries with q parameter', async () => {
      mockClient.msearch.mockResolvedValue({
        body: {
          responses: [
            {
              hits: {
                total: { value: 1 },
                hits: [{ _id: 'pkg-1', _source: { name: 'test' }, _score: 5 }],
              },
            },
            { hits: { total: { value: 0 }, hits: [] } },
            { hits: { total: { value: 0 }, hits: [] } },
          ],
        },
      })

      const result = await adapter.search({ q: 'test query', offset: 0, limit: 10 })

      expect(mockClient.msearch).toHaveBeenCalled()
      expect(mockClient.search).not.toHaveBeenCalled()
      expect(result.items).toHaveLength(1)
    })

    it('should use single search for empty query (browse mode)', async () => {
      mockClient.search.mockResolvedValue({
        body: { hits: { total: { value: 0 }, hits: [] } },
      })

      await adapter.search({ q: '', offset: 0, limit: 20 })

      expect(mockClient.search).toHaveBeenCalled()
      expect(mockClient.msearch).not.toHaveBeenCalled()
    })

    it('should merge content matches into matchedResources', async () => {
      mockClient.msearch.mockResolvedValue({
        body: {
          responses: [
            {
              hits: {
                total: { value: 1 },
                hits: [{ _id: 'pkg-1', _source: { name: 'population' }, _score: 5 }],
              },
            },
            { hits: { total: { value: 0 }, hits: [] } },
            {
              hits: {
                total: { value: 1 },
                hits: [
                  {
                    _id: 'chunk-res1-0',
                    _source: { resourceId: 'res-1', packageId: 'pkg-1' },
                    _score: 3,
                  },
                ],
              },
            },
          ],
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
    it('should delete from packages index', async () => {
      mockClient.delete.mockResolvedValue({ body: {} })

      await adapter.deletePackage('pkg-1')

      expect(mockClient.delete).toHaveBeenCalledWith({
        index: 'kukan-packages',
        id: 'pkg-1',
        refresh: 'wait_for',
      })
    })

    it('should ignore 404 errors', async () => {
      mockClient.delete.mockRejectedValue({ statusCode: 404 })
      await expect(adapter.deletePackage('nonexistent')).resolves.toBeUndefined()
    })
  })

  describe('deleteResource', () => {
    it('should delete from resources index', async () => {
      mockClient.delete.mockResolvedValue({ body: {} })

      await adapter.deleteResource('res-1')

      expect(mockClient.delete).toHaveBeenCalledWith({
        index: 'kukan-resources',
        id: 'res-1',
        refresh: 'wait_for',
      })
    })
  })

  describe('bulkIndexPackages', () => {
    it('should bulk index to packages index', async () => {
      mockClient.bulk.mockResolvedValue({ body: { errors: false, items: [] } })

      await adapter.bulkIndexPackages([
        { id: 'pkg-1', name: 'dataset-1' },
        { id: 'pkg-2', name: 'dataset-2' },
      ])

      expect(mockClient.bulk).toHaveBeenCalledWith({
        body: [
          { index: { _index: 'kukan-packages', _id: 'pkg-1' } },
          expect.objectContaining({ id: 'pkg-1' }),
          { index: { _index: 'kukan-packages', _id: 'pkg-2' } },
          expect.objectContaining({ id: 'pkg-2' }),
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
    it('should bulk index to resources index', async () => {
      mockClient.bulk.mockResolvedValue({ body: { errors: false, items: [] } })

      await adapter.bulkIndexResources([
        { id: 'res-1', packageId: 'pkg-1', name: 'data.csv' },
        { id: 'res-2', packageId: 'pkg-1', name: 'data.json' },
      ])

      expect(mockClient.bulk).toHaveBeenCalledWith({
        body: [
          { index: { _index: 'kukan-resources', _id: 'res-1' } },
          expect.objectContaining({ id: 'res-1', packageId: 'pkg-1' }),
          { index: { _index: 'kukan-resources', _id: 'res-2' } },
          expect.objectContaining({ id: 'res-2' }),
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
                _source: { name: 'test' },
                _score: 5,
                highlight: {
                  title: ['<script>alert(1)</script><mark>test</mark>'],
                },
              },
            ],
          },
        },
      })

      // Use empty query to go through single search path (not msearch)
      // We need a query to trigger highlighting, but the browse path won't have highlights
      // So we test via msearch path
      mockClient.msearch.mockResolvedValue({
        body: {
          responses: [
            {
              hits: {
                total: { value: 1 },
                hits: [
                  {
                    _id: 'pkg-1',
                    _source: { name: 'test' },
                    _score: 5,
                    highlight: {
                      title: ['<script>alert(1)</script><mark>test</mark>'],
                      notes: ['<img onerror=alert(1)><mark>note</mark>'],
                    },
                  },
                ],
              },
            },
            { hits: { total: { value: 0 }, hits: [] } },
            { hits: { total: { value: 0 }, hits: [] } },
          ],
        },
      })

      const result = await adapter.search({ q: 'test' })

      // Script and img tags should be stripped, only <mark> preserved
      expect(result.items[0].highlightedTitle).toBe('alert(1)<mark>test</mark>')
      expect(result.items[0].highlightedNotes).toBe('<mark>note</mark>')
    })

    it('should sanitize XSS in resource and content highlight snippets', async () => {
      mockClient.msearch.mockResolvedValue({
        body: {
          responses: [
            {
              hits: {
                total: { value: 1 },
                hits: [{ _id: 'pkg-1', _source: { name: 'test' }, _score: 5 }],
              },
            },
            {
              hits: {
                total: { value: 1 },
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
            {
              hits: {
                total: { value: 1 },
                hits: [
                  {
                    _id: 'chunk-res1-0',
                    _source: { resourceId: 'res-1', packageId: 'pkg-1' },
                    _score: 2,
                  },
                ],
              },
            },
          ],
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
    it('should return document source by ID', async () => {
      mockClient.get.mockResolvedValue({
        body: { _id: 'pkg-1', _source: { name: 'test', title: 'Test' } },
      })

      const doc = await adapter.getDocument('packages', 'pkg-1')

      expect(mockClient.get).toHaveBeenCalledWith({ index: 'kukan-packages', id: 'pkg-1' })
      expect(doc).toEqual({ name: 'test', title: 'Test' })
    })

    it('should return null for non-existent document', async () => {
      mockClient.get.mockRejectedValue({ statusCode: 404 })

      const doc = await adapter.getDocument('resources', 'nonexistent')

      expect(doc).toBeNull()
    })

    it('should resolve correct index name', async () => {
      mockClient.get.mockResolvedValue({
        body: { _id: 'res-1', _source: { name: 'data.csv' } },
      })

      await adapter.getDocument('resources', 'res-1')

      expect(mockClient.get).toHaveBeenCalledWith({ index: 'kukan-resources', id: 'res-1' })
    })
  })

  describe('browseDocuments', () => {
    it('should return paginated documents', async () => {
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
    })

    it('should exclude extractedText from contents browse', async () => {
      mockClient.search.mockResolvedValue({
        body: { hits: { total: { value: 0 }, hits: [] } },
      })

      await adapter.browseDocuments('contents', { offset: 0, limit: 10 })

      const callArgs = mockClient.search.mock.calls[0][0]
      expect(callArgs.body._source).toEqual({ excludes: ['extractedText'] })
    })

    it('should search with correct fields per index', async () => {
      mockClient.search.mockResolvedValue({
        body: { hits: { total: { value: 0 }, hits: [] } },
      })

      await adapter.browseDocuments('resources', { q: 'test', offset: 0 })

      const callArgs = mockClient.search.mock.calls[0][0]
      expect(callArgs.body.query.multi_match).toEqual(
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
    it('should use resourceId_chunk_N as doc id', async () => {
      mockClient.index.mockResolvedValue({ body: {} })

      await adapter.indexContent({
        resourceId: 'res-1',
        packageId: 'pkg-1',
        extractedText: 'some text content',
        contentType: 'text',
        chunkIndex: 0,
      })

      expect(mockClient.index).toHaveBeenCalledWith({
        index: 'kukan-contents',
        id: 'res-1_chunk_0',
        body: expect.objectContaining({
          resourceId: 'res-1',
          chunkIndex: 0,
        }),
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
        index: 'kukan-contents',
        id: 'res-1_chunk_1',
        body: expect.objectContaining({
          resourceId: 'res-1',
          chunkIndex: 1,
        }),
        refresh: 'wait_for',
      })
    })
  })

  describe('deleteContent', () => {
    it('should delete all chunks by resourceId using deleteByQuery', async () => {
      mockClient.deleteByQuery.mockResolvedValue({ body: {} })

      await adapter.deleteContent('res-1')

      expect(mockClient.deleteByQuery).toHaveBeenCalledWith({
        index: 'kukan-contents',
        body: { query: { term: { resourceId: 'res-1' } } },
        refresh: true,
      })
    })
  })

  describe('deleteAllPackages', () => {
    it('should delete and recreate the packages index', async () => {
      mockClient.indices.delete.mockResolvedValue({ body: {} })

      await adapter.deleteAllPackages()

      expect(mockClient.indices.delete).toHaveBeenCalledWith({ index: 'kukan-packages' })
      // After delete, ensureIndex is called which recreates all indices
      expect(mockClient.indices.create).toHaveBeenCalled()
    })

    it('should ignore 404 when index does not exist', async () => {
      mockClient.indices.delete.mockRejectedValue({ statusCode: 404 })

      await expect(adapter.deleteAllPackages()).resolves.toBeUndefined()
    })
  })

  describe('deleteAllResources', () => {
    it('should delete and recreate the resources index', async () => {
      mockClient.indices.delete.mockResolvedValue({ body: {} })

      await adapter.deleteAllResources()

      expect(mockClient.indices.delete).toHaveBeenCalledWith({ index: 'kukan-resources' })
      expect(mockClient.indices.create).toHaveBeenCalled()
    })
  })

  describe('deleteAllContents', () => {
    it('should delete and recreate the contents index', async () => {
      mockClient.indices.delete.mockResolvedValue({ body: {} })

      await adapter.deleteAllContents()

      expect(mockClient.indices.delete).toHaveBeenCalledWith({ index: 'kukan-contents' })
      expect(mockClient.indices.create).toHaveBeenCalled()
    })
  })

  describe('content-only match (mget fallback)', () => {
    it('should fetch and include packages matched only via resource content', async () => {
      mockClient.msearch.mockResolvedValue({
        body: {
          responses: [
            // Packages: no direct match
            { hits: { total: { value: 0 }, hits: [] } },
            // Resources: no metadata match
            { hits: { total: { value: 0 }, hits: [] } },
            // Contents: match in pkg-2 (not in packages result)
            {
              hits: {
                total: { value: 1 },
                hits: [
                  {
                    _id: 'chunk-res1-0',
                    _source: { resourceId: 'res-1', packageId: 'pkg-2' },
                    _score: 3,
                  },
                ],
              },
            },
          ],
        },
      })

      // mget for resource metadata (content-only match)
      mockClient.mget.mockResolvedValueOnce({
        body: {
          docs: [
            {
              _id: 'res-1',
              found: true,
              _source: { name: 'data.csv', format: 'CSV' },
            },
          ],
        },
      })

      // mget returns the missing package
      mockClient.mget.mockResolvedValueOnce({
        body: {
          docs: [
            {
              _id: 'pkg-2',
              found: true,
              _source: { name: 'content-only-pkg', title: 'Content Only Package' },
            },
          ],
        },
      })

      const result = await adapter.search({ q: 'keyword' })

      expect(mockClient.mget).toHaveBeenCalledWith({
        index: 'kukan-packages',
        body: { ids: ['pkg-2'] },
      })
      expect(result.items).toHaveLength(1)
      expect(result.items[0].name).toBe('content-only-pkg')
      expect(result.items[0].matchedResources).toHaveLength(1)
      expect(result.items[0].matchedResources![0]._contentDocId).toBe('chunk-res1-0')
      expect(result.items[0].matchedResources![0].matchSource).toBe('content')
    })

    it('should fetch resource metadata (name, format) for content-only matches', async () => {
      mockClient.msearch.mockResolvedValue({
        body: {
          responses: [
            { hits: { total: { value: 0 }, hits: [] } },
            { hits: { total: { value: 0 }, hits: [] } },
            {
              hits: {
                total: { value: 1 },
                hits: [
                  {
                    _id: 'chunk-res1-0',
                    _source: { resourceId: 'res-1', packageId: 'pkg-1' },
                    _score: 2,
                  },
                ],
              },
            },
          ],
        },
      })

      // First mget: resource metadata
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

      // Second mget: missing package
      mockClient.mget.mockResolvedValueOnce({
        body: {
          docs: [
            {
              _id: 'pkg-1',
              found: true,
              _source: { name: 'my-dataset', title: 'My Dataset' },
            },
          ],
        },
      })

      const result = await adapter.search({ q: 'test' })

      // Should have fetched resource metadata from kukan-resources
      expect(mockClient.mget).toHaveBeenCalledWith({
        index: 'kukan-resources',
        body: { ids: ['res-1'] },
      })

      const mr = result.items[0].matchedResources![0]
      expect(mr.name).toBe('data.csv')
      expect(mr.description).toBe('Test data')
      expect(mr.format).toBe('CSV')
      expect(mr.matchSource).toBe('content')
      expect(mr._contentDocId).toBe('chunk-res1-0')
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
  })

  describe('search content + resource overlap', () => {
    it('should attach _contentDocId when resource matches both metadata and content', async () => {
      mockClient.msearch.mockResolvedValue({
        body: {
          responses: [
            {
              hits: {
                total: { value: 1 },
                hits: [{ _id: 'pkg-1', _source: { name: 'test-pkg' }, _score: 5 }],
              },
            },
            // Resource metadata match
            {
              hits: {
                total: { value: 1 },
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
            {
              hits: {
                total: { value: 1 },
                hits: [
                  {
                    _id: 'chunk-res1-0',
                    _source: { resourceId: 'res-1', packageId: 'pkg-1' },
                    _score: 2,
                  },
                ],
              },
            },
          ],
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
    it('should return resource count for matching packages', async () => {
      mockClient.indices.exists.mockResolvedValue({ body: true })
      mockClient.search.mockResolvedValue({
        body: {
          aggregations: {
            package_ids: {
              buckets: [{ key: 'pkg-1' }, { key: 'pkg-2' }],
            },
          },
        },
      })
      mockClient.count.mockResolvedValue({ body: { count: 5 } })

      const result = await adapter.sumResourceCount()

      expect(mockClient.search).toHaveBeenCalledWith(
        expect.objectContaining({ index: 'kukan-packages' })
      )
      expect(mockClient.count).toHaveBeenCalledWith({
        index: 'kukan-resources',
        body: { query: { terms: { packageId: ['pkg-1', 'pkg-2'] } } },
      })
      expect(result).toBe(5)
    })

    it('should return 0 when no packages match', async () => {
      mockClient.indices.exists.mockResolvedValue({ body: true })
      mockClient.search.mockResolvedValue({
        body: { aggregations: { package_ids: { buckets: [] } } },
      })

      const result = await adapter.sumResourceCount()

      expect(result).toBe(0)
      expect(mockClient.count).not.toHaveBeenCalled()
    })

    it('should pass query and filters to package search', async () => {
      mockClient.indices.exists.mockResolvedValue({ body: true })
      mockClient.search.mockResolvedValue({
        body: { aggregations: { package_ids: { buckets: [{ key: 'pkg-1' }] } } },
      })
      mockClient.count.mockResolvedValue({ body: { count: 3 } })

      await adapter.sumResourceCount({
        q: 'population',
        filters: { organizations: ['tokyo'] },
      })

      const searchCall = mockClient.search.mock.calls[0][0]
      expect(searchCall.index).toBe('kukan-packages')
      expect(searchCall.body.query.bool.must).toBeDefined()
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
        index: 'kukan-contents',
        body: expect.objectContaining({
          query: { term: { resourceId: 'res-1' } },
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
      expect(searchCall.body.query).toEqual({
        match: { extractedText: { query: 'population', operator: 'and' } },
      })
    })
  })
})
