import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenSearchAdapter } from '../opensearch'

// Mock the OpenSearch client
vi.mock('@opensearch-project/opensearch', () => {
  const mockClient = {
    indices: {
      exists: vi.fn(),
      create: vi.fn(),
    },
    index: vi.fn(),
    search: vi.fn(),
    msearch: vi.fn(),
    mget: vi.fn(),
    count: vi.fn(),
    delete: vi.fn(),
    deleteByQuery: vi.fn(),
    bulk: vi.fn(),
  }
  return {
    Client: vi.fn(() => mockClient),
    __mockClient: mockClient,
  }
})

interface MockClient {
  indices: { exists: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }
  index: ReturnType<typeof vi.fn>
  search: ReturnType<typeof vi.fn>
  msearch: ReturnType<typeof vi.fn>
  mget: ReturnType<typeof vi.fn>
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
    it('should create both packages and resources indices', async () => {
      await adapter.ensureIndex()

      expect(mockClient.indices.exists).toHaveBeenCalledTimes(2)
      expect(mockClient.indices.create).toHaveBeenCalledTimes(2)

      const createCalls = mockClient.indices.create.mock.calls
      expect(createCalls[0][0].index).toBe('kukan-packages')
      expect(createCalls[1][0].index).toBe('kukan-resources')
    })

    it('should not create nested resources mapping in packages index', async () => {
      await adapter.ensureIndex()

      const packagesCreateCall = mockClient.indices.create.mock.calls[0][0]
      const props = packagesCreateCall.body.mappings.properties
      expect(props.resources).toBeUndefined()
      expect(props.title.type).toBe('text')
      expect(props.formats.type).toBe('keyword')
    })

    it('should create resources index with extractedText field', async () => {
      await adapter.ensureIndex()

      const resourcesCreateCall = mockClient.indices.create.mock.calls[1][0]
      const props = resourcesCreateCall.body.mappings.properties
      expect(props.extractedText).toEqual({ type: 'text', analyzer: 'kuromoji_analyzer' })
      expect(props.packageId.type).toBe('keyword')
      expect(props.name.type).toBe('text')
      expect(props.description.type).toBe('text')
      expect(props.contentType.type).toBe('keyword')
    })

    it('should skip creation when indices already exist', async () => {
      mockClient.indices.exists.mockResolvedValue({ body: true })

      await adapter.ensureIndex()

      expect(mockClient.indices.create).not.toHaveBeenCalled()
    })

    it('should only check once (idempotent)', async () => {
      await adapter.ensureIndex()
      await adapter.ensureIndex()

      // 2 calls on first ensureIndex (packages + resources), then 0 on second
      expect(mockClient.indices.exists).toHaveBeenCalledTimes(2)
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

  describe('index', () => {
    it('should index a document to packages index', async () => {
      mockClient.index.mockResolvedValue({ body: {} })

      await adapter.index({
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
        extractedText: 'Tokyo,13960000',
      })

      expect(mockClient.index).toHaveBeenCalledWith({
        index: 'kukan-resources',
        id: 'res-1',
        body: expect.objectContaining({
          id: 'res-1',
          packageId: 'pkg-1',
          extractedText: 'Tokyo,13960000',
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
            { hits: { total: { value: 1 }, hits: [{ _id: 'pkg-1', _source: { name: 'test' }, _score: 5 }] } },
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

    it('should merge resource content matches into matchedResources', async () => {
      mockClient.msearch.mockResolvedValue({
        body: {
          responses: [
            {
              hits: {
                total: { value: 1 },
                hits: [{ _id: 'pkg-1', _source: { name: 'population' }, _score: 5 }],
              },
            },
            {
              hits: {
                total: { value: 1 },
                hits: [
                  {
                    _id: 'res-1',
                    _source: { id: 'res-1', packageId: 'pkg-1', name: 'data.csv', format: 'CSV' },
                    _score: 3,
                    highlight: { extractedText: ['...東京都の<mark>人口</mark>は...'] },
                  },
                ],
              },
            },
          ],
        },
      })

      const result = await adapter.search({ q: '人口', offset: 0, limit: 10 })

      expect(result.items).toHaveLength(1)
      expect(result.items[0].matchedResources).toHaveLength(1)
      expect(result.items[0].matchedResources![0]).toEqual(
        expect.objectContaining({
          id: 'res-1',
          name: 'data.csv',
          matchSource: 'content',
          contentSnippet: '...東京都の<mark>人口</mark>は...',
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

  describe('delete', () => {
    it('should delete from packages index', async () => {
      mockClient.delete.mockResolvedValue({ body: {} })

      await adapter.delete('pkg-1')

      expect(mockClient.delete).toHaveBeenCalledWith({
        index: 'kukan-packages',
        id: 'pkg-1',
        refresh: 'wait_for',
      })
    })

    it('should ignore 404 errors', async () => {
      mockClient.delete.mockRejectedValue({ statusCode: 404 })
      await expect(adapter.delete('nonexistent')).resolves.toBeUndefined()
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

  describe('bulkIndex', () => {
    it('should bulk index to packages index', async () => {
      mockClient.bulk.mockResolvedValue({ body: { errors: false, items: [] } })

      await adapter.bulkIndex([
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
      await adapter.bulkIndex([])
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
})
