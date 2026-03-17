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
    it('should search with multi_match for non-empty query', async () => {
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

      expect(mockClient.search).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            query: expect.objectContaining({
              bool: expect.objectContaining({
                must: expect.arrayContaining([
                  expect.objectContaining({
                    multi_match: expect.objectContaining({
                      query: 'test query',
                      fields: ['title^3', 'name^2', 'notes', 'tags'],
                    }),
                  }),
                ]),
              }),
            }),
          }),
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
        filters: { organization: 'test-org' },
      })

      expect(mockClient.search).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            query: expect.objectContaining({
              bool: expect.objectContaining({
                filter: expect.arrayContaining([
                  { term: { organization: 'test-org' } },
                ]),
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
                  { terms: { tags: ['env', 'health'] } },
                ]),
              }),
            }),
          }),
        })
      )
    })

    it('should handle numeric total (OpenSearch compat)', async () => {
      mockClient.search.mockResolvedValue({
        body: { hits: { total: 5, hits: [] } },
      })

      const result = await adapter.search({ q: 'test' })
      expect(result.total).toBe(5)
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
          items: [
            { index: { error: { reason: 'mapping error' } } },
          ],
        },
      })

      await expect(
        adapter.bulkIndex([{ id: 'pkg-1', name: 'bad' }])
      ).rejects.toThrow('Bulk indexing failed for 1 documents')
    })
  })
})
