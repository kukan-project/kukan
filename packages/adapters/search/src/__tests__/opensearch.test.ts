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
    delete: vi.fn(),
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
  delete: ReturnType<typeof vi.fn>
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
    // Default: index does not exist
    mockClient.indices.exists.mockResolvedValue({ body: false })
    mockClient.indices.create.mockResolvedValue({ body: {} })
  })

  describe('ensureIndex', () => {
    it('should create index with kuromoji mapping when not exists', async () => {
      await adapter.ensureIndex()

      expect(mockClient.indices.exists).toHaveBeenCalledWith({
        index: 'kukan-packages',
      })
      expect(mockClient.indices.create).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'kukan-packages',
          body: expect.objectContaining({
            settings: expect.objectContaining({
              analysis: expect.objectContaining({
                analyzer: expect.objectContaining({
                  kuromoji_analyzer: expect.any(Object),
                }),
              }),
            }),
          }),
        })
      )
    })

    it('should skip creation when index already exists', async () => {
      mockClient.indices.exists.mockResolvedValue({ body: true })

      await adapter.ensureIndex()

      expect(mockClient.indices.create).not.toHaveBeenCalled()
    })

    it('should only check once (idempotent)', async () => {
      await adapter.ensureIndex()
      await adapter.ensureIndex()

      expect(mockClient.indices.exists).toHaveBeenCalledTimes(1)
    })

    it('should include license_id, groups, formats keyword mappings', async () => {
      await adapter.ensureIndex()

      const createCall = mockClient.indices.create.mock.calls[0][0]
      const props = createCall.body.mappings.properties

      expect(props.license_id).toEqual({ type: 'keyword' })
      expect(props.groups).toEqual({ type: 'keyword' })
      expect(props.formats).toEqual({ type: 'keyword' })
    })

    it('should include resources nested mapping', async () => {
      await adapter.ensureIndex()

      const createCall = mockClient.indices.create.mock.calls[0][0]
      const resourcesMapping = createCall.body.mappings.properties.resources

      expect(resourcesMapping.type).toBe('nested')
      expect(resourcesMapping.properties.id.type).toBe('keyword')
      expect(resourcesMapping.properties.name.type).toBe('text')
      expect(resourcesMapping.properties.name.analyzer).toBe('kuromoji_analyzer')
      expect(resourcesMapping.properties.description.type).toBe('text')
      expect(resourcesMapping.properties.format.type).toBe('keyword')
    })

    it('should use custom index prefix', async () => {
      const customAdapter = new OpenSearchAdapter({
        endpoint: 'http://localhost:9200',
        indexPrefix: 'test',
      })
      mockClient.indices.exists.mockResolvedValue({ body: false })

      await customAdapter.ensureIndex()

      expect(mockClient.indices.exists).toHaveBeenCalledWith({
        index: 'test-packages',
      })
    })
  })

  describe('index', () => {
    it('should index a document', async () => {
      mockClient.index.mockResolvedValue({ body: {} })

      await adapter.index({
        id: 'pkg-1',
        name: 'test-dataset',
        title: 'Test Dataset',
        notes: 'Test notes',
        tags: ['open-data'],
        organization: 'test-org',
      })

      expect(mockClient.index).toHaveBeenCalledWith({
        index: 'kukan-packages',
        id: 'pkg-1',
        body: expect.objectContaining({
          id: 'pkg-1',
          name: 'test-dataset',
          title: 'Test Dataset',
        }),
        refresh: 'wait_for',
      })
    })
  })

  describe('search', () => {
    it('should search with bool.should (dataset + nested resource) for non-empty query', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _id: 'pkg-1',
                _source: { id: 'pkg-1', name: 'test', title: 'Test' },
              },
            ],
          },
        },
      })

      const result = await adapter.search({ q: 'test query', offset: 0, limit: 10 })

      const callArgs = mockClient.search.mock.calls[0][0]
      const mustClause = callArgs.body.query.bool.must[0]

      // Should be a bool.should with dataset multi_match + nested resource query
      expect(mustClause.bool.should).toHaveLength(2)
      expect(mustClause.bool.minimum_should_match).toBe(1)

      // Dataset-level multi_match (cross_fields + operator: and)
      expect(mustClause.bool.should[0].multi_match).toEqual(
        expect.objectContaining({
          query: 'test query',
          fields: ['title^3', 'name^2', 'notes', 'tags'],
          type: 'cross_fields',
          operator: 'and',
        })
      )

      // Nested resource query with inner_hits
      expect(mustClause.bool.should[1].nested).toEqual(
        expect.objectContaining({
          path: 'resources',
          inner_hits: { size: 100 },
        })
      )
      expect(mustClause.bool.should[1].nested.query.multi_match).toEqual(
        expect.objectContaining({
          query: 'test query',
          fields: ['resources.name^2', 'resources.description'],
          type: 'cross_fields',
          operator: 'and',
        })
      )

      expect(result.items).toHaveLength(1)
      expect(result.items[0].id).toBe('pkg-1')
      expect(result.total).toBe(1)
    })

    it('should use match_all for empty query', async () => {
      mockClient.search.mockResolvedValue({
        body: { hits: { total: { value: 0 }, hits: [] } },
      })

      await adapter.search({ q: '', offset: 0, limit: 20 })

      expect(mockClient.search).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            query: expect.objectContaining({
              bool: expect.objectContaining({
                must: [{ match_all: {} }],
              }),
            }),
          }),
        })
      )
    })

    it('should apply organization filter', async () => {
      mockClient.search.mockResolvedValue({
        body: { hits: { total: { value: 0 }, hits: [] } },
      })

      await adapter.search({
        q: 'data',
        filters: { organizations: ['test-org'] },
      })

      expect(mockClient.search).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            query: expect.objectContaining({
              bool: expect.objectContaining({
                filter: expect.arrayContaining([{ terms: { organization: ['test-org'] } }]),
              }),
            }),
          }),
        })
      )
    })

    it('should apply tags filter', async () => {
      mockClient.search.mockResolvedValue({
        body: { hits: { total: { value: 0 }, hits: [] } },
      })

      await adapter.search({
        q: 'data',
        filters: { tags: ['env', 'health'] },
      })

      expect(mockClient.search).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            query: expect.objectContaining({
              bool: expect.objectContaining({
                filter: expect.arrayContaining([
                  { term: { tags: 'env' } },
                  { term: { tags: 'health' } },
                ]),
              }),
            }),
          }),
        })
      )
    })

    it('should extract matchedResources from inner_hits', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _id: 'pkg-1',
                _source: { id: 'pkg-1', name: 'test', title: 'Test' },
                inner_hits: {
                  resources: {
                    hits: {
                      hits: [
                        {
                          _source: {
                            id: 'res-1',
                            name: 'data.csv',
                            description: 'Test data file',
                            format: 'CSV',
                          },
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

      expect(result.items).toHaveLength(1)
      expect(result.items[0].matchedResources).toEqual([
        {
          id: 'res-1',
          name: 'data.csv',
          description: 'Test data file',
          format: 'CSV',
        },
      ])
    })

    it('should not include matchedResources when no inner_hits', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _id: 'pkg-1',
                _source: { id: 'pkg-1', name: 'test', title: 'Test' },
              },
            ],
          },
        },
      })

      const result = await adapter.search({ q: 'test', offset: 0, limit: 10 })

      expect(result.items[0].matchedResources).toBeUndefined()
    })

    it('should strip resources array from search results', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _id: 'pkg-1',
                _source: {
                  id: 'pkg-1',
                  name: 'test',
                  resources: [{ id: 'res-1', name: 'file.csv' }],
                },
              },
            ],
          },
        },
      })

      const result = await adapter.search({ q: 'test', offset: 0, limit: 10 })

      expect(result.items[0].resources).toBeUndefined()
    })

    it('should handle numeric total (OpenSearch compat)', async () => {
      mockClient.search.mockResolvedValue({
        body: { hits: { total: 5, hits: [] } },
      })

      const result = await adapter.search({ q: 'test' })
      expect(result.total).toBe(5)
    })

    it('should apply formats, license_id, and groups filters', async () => {
      mockClient.search.mockResolvedValue({
        body: { hits: { total: { value: 0 }, hits: [] } },
      })

      await adapter.search({
        q: 'data',
        filters: {
          formats: ['csv', 'json'],
          licenses: ['cc-by'],
          groups: ['environment'],
        },
      })

      const callArgs = mockClient.search.mock.calls[0][0]
      const filterClauses = callArgs.body.query.bool.filter

      expect(filterClauses).toEqual(
        expect.arrayContaining([
          { term: { formats: 'CSV' } },
          { term: { formats: 'JSON' } },
          { terms: { license_id: ['cc-by'] } },
          { term: { groups: 'environment' } },
        ])
      )
    })

    it('should include aggregations when facets=true', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: { total: { value: 0 }, hits: [] },
          aggregations: {
            organizations: { buckets: [{ key: 'org-a', doc_count: 5 }] },
            tags: { buckets: [{ key: 'env', doc_count: 3 }] },
            formats: { buckets: [{ key: 'CSV', doc_count: 2 }] },
            licenses: { buckets: [{ key: 'cc-by', doc_count: 1 }] },
            groups: { buckets: [] },
          },
        },
      })

      const result = await adapter.search({ q: 'data', facets: true })

      // Verify aggregations were requested
      const callArgs = mockClient.search.mock.calls[0][0]
      expect(callArgs.body.aggs).toBeDefined()
      expect(callArgs.body.aggs.organizations).toEqual({
        terms: { field: 'organization', size: 200 },
      })
      expect(callArgs.body.aggs.tags).toEqual({ terms: { field: 'tags', size: 200 } })

      // Verify parsed facets
      expect(result.facets).toEqual({
        organizations: [{ name: 'org-a', count: 5 }],
        tags: [{ name: 'env', count: 3 }],
        formats: [{ name: 'CSV', count: 2 }],
        licenses: [{ name: 'cc-by', count: 1 }],
        groups: [],
      })
    })

    it('should not include aggregations when facets is not set', async () => {
      mockClient.search.mockResolvedValue({
        body: { hits: { total: { value: 0 }, hits: [] } },
      })

      const result = await adapter.search({ q: 'data' })

      const callArgs = mockClient.search.mock.calls[0][0]
      expect(callArgs.body.aggs).toBeUndefined()
      expect(result.facets).toBeUndefined()
    })

    describe('sort', () => {
      beforeEach(() => {
        mockClient.search.mockResolvedValue({
          body: { hits: { total: { value: 0 }, hits: [] } },
        })
      })

      it('should sort by updated DESC when browsing without explicit sort', async () => {
        await adapter.search({ q: '' })

        const callArgs = mockClient.search.mock.calls[0][0]
        expect(callArgs.body.sort).toEqual([{ updated: { order: 'desc' } }])
      })

      it('should sort by _score then updated DESC when searching without explicit sort', async () => {
        await adapter.search({ q: 'test query' })

        const callArgs = mockClient.search.mock.calls[0][0]
        expect(callArgs.body.sort).toEqual(['_score', { updated: { order: 'desc' } }])
      })

      it('should sort by specified field when sortBy is set', async () => {
        await adapter.search({ q: 'test', sortBy: 'created', sortOrder: 'asc' })

        const callArgs = mockClient.search.mock.calls[0][0]
        expect(callArgs.body.sort).toEqual([{ created: { order: 'asc' } }])
      })

      it('should sort by name ascending', async () => {
        await adapter.search({ q: '', sortBy: 'name', sortOrder: 'asc' })

        const callArgs = mockClient.search.mock.calls[0][0]
        expect(callArgs.body.sort).toEqual([{ name: { order: 'asc' } }])
      })

      it('should ignore _score when explicit sort is set even with query', async () => {
        await adapter.search({ q: 'test query', sortBy: 'updated', sortOrder: 'desc' })

        const callArgs = mockClient.search.mock.calls[0][0]
        expect(callArgs.body.sort).toEqual([{ updated: { order: 'desc' } }])
      })

      it('should default sortOrder to desc when only sortBy is provided', async () => {
        await adapter.search({ q: '', sortBy: 'created' })

        const callArgs = mockClient.search.mock.calls[0][0]
        expect(callArgs.body.sort).toEqual([{ created: { order: 'desc' } }])
      })
    })
  })

  describe('delete', () => {
    it('should delete a document', async () => {
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

    it('should throw non-404 errors', async () => {
      mockClient.delete.mockRejectedValue(new Error('connection failed'))

      await expect(adapter.delete('pkg-1')).rejects.toThrow('connection failed')
    })
  })

  describe('bulkIndex', () => {
    it('should bulk index documents', async () => {
      mockClient.bulk.mockResolvedValue({
        body: { errors: false, items: [] },
      })

      await adapter.bulkIndex([
        { id: 'pkg-1', name: 'dataset-1', title: 'Dataset 1' },
        { id: 'pkg-2', name: 'dataset-2', title: 'Dataset 2' },
      ])

      expect(mockClient.bulk).toHaveBeenCalledWith({
        body: [
          { index: { _index: 'kukan-packages', _id: 'pkg-1' } },
          expect.objectContaining({ id: 'pkg-1', name: 'dataset-1' }),
          { index: { _index: 'kukan-packages', _id: 'pkg-2' } },
          expect.objectContaining({ id: 'pkg-2', name: 'dataset-2' }),
        ],
        refresh: 'wait_for',
      })
    })

    it('should skip empty array', async () => {
      await adapter.bulkIndex([])
      expect(mockClient.bulk).not.toHaveBeenCalled()
    })

    it('should throw on bulk errors', async () => {
      mockClient.bulk.mockResolvedValue({
        body: {
          errors: true,
          items: [{ index: { error: { reason: 'mapping error' } } }],
        },
      })

      await expect(adapter.bulkIndex([{ id: 'pkg-1', name: 'bad' }])).rejects.toThrow(
        'Bulk indexing failed for 1 documents'
      )
    })
  })
})
