import { describe, it, expect, vi, beforeEach } from 'vitest'
import { errors as osErrors } from '@opensearch-project/opensearch'
import { OpenSearchAdapter, extrasPair, isSearchWriteUnavailable } from '../opensearch'
import { BulkIndexError, extrasMatchValues } from '../adapter'

// Mock only the OpenSearch client; keep the real `errors` export so error-type
// classification (instanceof checks) behaves identically to production.
vi.mock('@opensearch-project/opensearch', async (importActual) => {
  const actual = (await importActual()) as typeof import('@opensearch-project/opensearch')
  const mockClient = {
    indices: {
      exists: vi.fn(),
      existsAlias: vi.fn(),
      getAlias: vi.fn(),
      getMapping: vi.fn(),
      putAlias: vi.fn(),
      updateAliases: vi.fn(),
      getSettings: vi.fn(),
      putMapping: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    index: vi.fn(),
    search: vi.fn(),
    msearch: vi.fn(),
    mget: vi.fn(),
    get: vi.fn(),
    reindex: vi.fn(),
    tasks: {
      get: vi.fn(),
      cancel: vi.fn(),
    },
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
    existsAlias: ReturnType<typeof vi.fn>
    getAlias: ReturnType<typeof vi.fn>
    getMapping: ReturnType<typeof vi.fn>
    putAlias: ReturnType<typeof vi.fn>
    updateAliases: ReturnType<typeof vi.fn>
    getSettings: ReturnType<typeof vi.fn>
    putMapping: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
  }
  index: ReturnType<typeof vi.fn>
  search: ReturnType<typeof vi.fn>
  msearch: ReturnType<typeof vi.fn>
  mget: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  reindex: ReturnType<typeof vi.fn>
  tasks: {
    get: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
  }
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
    mockClient.indices.putAlias.mockResolvedValue({ body: {} })
    mockClient.indices.putMapping.mockResolvedValue({ body: {} })
    // Default: the alias is in front of the first numbered index
    mockClient.indices.existsAlias.mockResolvedValue({ body: true })
    mockClient.indices.getAlias.mockResolvedValue({ body: { 'kukan-search-000001': {} } })
    // Default: non-empty index (for empty-index detection)
    mockClient.count.mockResolvedValue({ body: { count: 10 } })
  })

  describe('ensureIndex', () => {
    it('should create a single search index with join field', async () => {
      await adapter.ensureIndex()

      expect(mockClient.indices.exists).toHaveBeenCalledTimes(1)
      expect(mockClient.indices.create).toHaveBeenCalledTimes(1)

      const createCall = mockClient.indices.create.mock.calls[0][0]
      // Created numbered, reached by the alias, so re-analysis has somewhere to
      // swap to later
      expect(createCall.index).toBe('kukan-search-000001')
      expect(mockClient.indices.putAlias).toHaveBeenCalledWith({
        index: 'kukan-search-000001',
        name: 'kukan-search',
      })
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
        search_analyzer: 'kuromoji_content_query_analyzer',
        index_options: 'offsets',
      })
      // Unified name field (text + keyword subfield)
      expect(props.name.type).toBe('text')
      expect(props.name.fields.keyword.type).toBe('keyword')
    })

    it('should apply the query-side stopword analyzer to metadata fields only', async () => {
      await adapter.ensureIndex()

      const createCall = mockClient.indices.create.mock.calls[0][0]
      const analysis = createCall.body.settings.analysis
      expect(analysis.analyzer.kuromoji_query_analyzer.filter).toContain('ja_request_words')
      expect(analysis.filter.ja_request_words.stopwords).toContain('欲しい')

      // Honorific prefixes go from both sides, unlike ja_request_words: 「お」in
      //「お年寄り」is not a term in a document either, and left in the index it
      // is what the highlighter marks inside「におい」and「お問い合わせ」.
      expect(analysis.filter.ja_prefix).toEqual({
        type: 'kuromoji_part_of_speech',
        stoptags: ['接頭詞-名詞接続'],
      })
      for (const a of ['kuromoji_analyzer', 'kuromoji_query_analyzer']) {
        expect(analysis.analyzer[a].filter).toContain('ja_prefix')
      }

      const props = createCall.body.mappings.properties
      for (const field of ['name', 'title', 'notes', 'description']) {
        expect(props[field].search_analyzer).toBe('kuromoji_query_analyzer')
      }
      // Content gets its own query side: the request boilerplate goes, and the
      // general stopword list does not. `ja_stop` drops「こと」「もの」「ため」
      // — words a document uses and a reader may be looking for — which is why
      // metadata's analyzer is the wrong one to reuse here.
      const content = analysis.analyzer.kuromoji_content_query_analyzer
      expect(props.extractedText.search_analyzer).toBe('kuromoji_content_query_analyzer')
      expect(content.filter).toContain('ja_request_words')
      expect(content.filter).not.toContain('ja_stop')
    })

    it('should skip creation when index already exists', async () => {
      mockClient.indices.exists.mockResolvedValue({ body: true })

      await adapter.ensureIndex()

      expect(mockClient.indices.create).not.toHaveBeenCalled()
      // An existence check only: the mapping is a write-path concern
      expect(mockClient.indices.putMapping).not.toHaveBeenCalled()
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
      expect(mockClient.indices.create.mock.calls[0][0].index).toBe('test-search-000001')
    })
  })

  describe('extras pairs (ADR-062)', () => {
    it('spells a number as PostgreSQL prints a jsonb one, never with an exponent', () => {
      // What `#>> '{}'` printed for these on PostgreSQL 16
      const numbers = [1e-7, 1.5e-7, 1e21, 1.2345e25, -2.5e-10, 123.456, 5, -0, 0.1]
      expect(numbers.flatMap(extrasMatchValues)).toEqual([
        '0.0000001',
        '0.00000015',
        '1000000000000000000000',
        '12345000000000000000000000',
        '-0.00000000025',
        '123.456',
        '5',
        '0',
        '0.1',
      ])
    })

    it('holds a long pair as its hash, which no pair can be taken for', () => {
      const long = 'x'.repeat(40_000)
      const hashed = extrasPair('spatial', long)
      expect(hashed).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(extrasPair('spatial', long)).toBe(hashed)
      expect(extrasPair('spatial', 'x')).toBe('["spatial","x"]')
    })
  })

  describe('bulkIndexPackages', () => {
    it('names the dataset documents the index refused, so the rest can settle', async () => {
      mockClient.indices.exists.mockResolvedValue({ body: true })
      mockClient.bulk.mockResolvedValue({
        body: {
          errors: true,
          items: [
            { index: { _id: 'pkg-1' } },
            { index: { _id: 'pkg-2', error: { type: 'mapper_parsing_exception' } } },
          ],
        },
      })

      const writing = adapter.bulkIndexPackages([
        { id: 'pkg-1', name: 'one' },
        { id: 'pkg-2', name: 'two' },
      ])

      await expect(writing).rejects.toBeInstanceOf(BulkIndexError)
      await expect(writing).rejects.toMatchObject({ failedIds: ['pkg-2'] })
      expect(mockClient.bulk.mock.calls[0][0].body[1]).toMatchObject({ join_field: 'package' })
    })

    it('writes extras as key-value pairs, by the rule a filter reads them (ADR-062)', async () => {
      mockClient.indices.exists.mockResolvedValue({ body: true })
      mockClient.bulk.mockResolvedValue({ body: { errors: false, items: [] } })

      await adapter.bulkIndexPackages([
        {
          id: 'pkg-1',
          name: 'one',
          extras: {
            unit: '市町村',
            n: 5,
            flag: false,
            area: ['a', 1, ['b'], { c: 1 }],
            o: {},
            z: null,
          },
        },
      ])
      await adapter.bulkIndexResources([
        { id: 'res-1', packageId: 'pkg-1', extras: { lang: 'ja', dup: ['x', 'x'] } },
        { id: 'res-2', packageId: 'pkg-1' },
      ])

      const doc = mockClient.bulk.mock.calls[0][0].body[1]
      expect(doc).not.toHaveProperty('extras')
      expect(doc.extras_pairs).toEqual([
        '["unit","市町村"]',
        '["n","5"]',
        '["flag","false"]',
        '["area","a"]',
        '["area","1"]',
      ])
      const resources = mockClient.bulk.mock.calls[1][0].body
      expect(resources[1].extras_pairs).toEqual(['["lang","ja"]', '["dup","x"]'])
      expect(resources[3].extras_pairs).toEqual([])
    })
  })

  describe('resource writes', () => {
    it('brings an existing index up to the current mapping once, before the first write', async () => {
      mockClient.indices.exists.mockResolvedValue({ body: true })
      mockClient.bulk.mockResolvedValue({ body: { errors: false, items: [] } })

      await adapter.bulkIndexResources([{ id: 'res-1', packageId: 'pkg-1', section: 'docs' }])
      await adapter.bulkIndexResources([{ id: 'res-2', packageId: 'pkg-1' }])

      expect(mockClient.indices.putMapping).toHaveBeenCalledTimes(1)
      expect(mockClient.indices.putMapping).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'kukan-search',
          body: {
            properties: expect.objectContaining({
              section: expect.objectContaining({ type: 'text' }),
              // The abstract is searched on the keyword leg (ADR-053 §8.1), so
              // it needs the Japanese analyzer like any other prose field
              summary: expect.objectContaining({
                type: 'text',
                analyzer: 'kuromoji_analyzer',
              }),
            }),
          },
        })
      )
      // An index from before the normalizer cannot take it on `format`, and
      // one refusal would hold back every other field in the request
      const sent = mockClient.indices.putMapping.mock.calls[0][0].body.properties
      expect(sent).not.toHaveProperty('format')
      expect(mockClient.bulk).toHaveBeenCalledTimes(2)
    })

    it('writes even when the index refuses the mapping, and does not ask again within a minute', async () => {
      mockClient.indices.exists.mockResolvedValue({ body: true })
      mockClient.indices.putMapping.mockRejectedValue(new Error('cluster_block_exception'))
      mockClient.bulk.mockResolvedValue({ body: { errors: false, items: [] } })

      await adapter.bulkIndexResources([{ id: 'res-1', packageId: 'pkg-1', section: 'docs' }])
      await adapter.bulkIndexResources([{ id: 'res-2', packageId: 'pkg-1' }])

      expect(mockClient.indices.putMapping).toHaveBeenCalledTimes(1)
      expect(mockClient.bulk).toHaveBeenCalledTimes(2)
    })

    it('asks for the mapping again a minute after a refusal, and once more only after it succeeds', async () => {
      const start = Date.now()
      const now = vi.spyOn(Date, 'now').mockReturnValue(start)
      try {
        mockClient.indices.exists.mockResolvedValue({ body: true })
        // Refused while the cluster was down, accepted once it is back
        mockClient.indices.putMapping
          .mockRejectedValueOnce(new Error('connection refused'))
          .mockResolvedValue({ body: {} })
        mockClient.bulk.mockResolvedValue({ body: { errors: false, items: [] } })

        await adapter.bulkIndexResources([{ id: 'res-1', packageId: 'pkg-1' }])
        now.mockReturnValue(start + 59_000)
        await adapter.bulkIndexResources([{ id: 'res-2', packageId: 'pkg-1' }])
        expect(mockClient.indices.putMapping).toHaveBeenCalledTimes(1)

        now.mockReturnValue(start + 60_000)
        await adapter.bulkIndexResources([{ id: 'res-3', packageId: 'pkg-1' }])
        expect(mockClient.indices.putMapping).toHaveBeenCalledTimes(2)

        // Settled now, for the life of the process
        now.mockReturnValue(start + 600_000)
        await adapter.bulkIndexResources([{ id: 'res-4', packageId: 'pkg-1' }])
        expect(mockClient.indices.putMapping).toHaveBeenCalledTimes(2)
        expect(mockClient.bulk).toHaveBeenCalledTimes(4)
      } finally {
        now.mockRestore()
      }
    })

    it('does not touch the mapping of an index it just created', async () => {
      mockClient.bulk.mockResolvedValue({ body: { errors: false, items: [] } })

      await adapter.bulkIndexResources([{ id: 'res-1', packageId: 'pkg-1' }])

      expect(mockClient.indices.create).toHaveBeenCalledTimes(1)
      expect(mockClient.indices.putMapping).not.toHaveBeenCalled()
    })
  })

  describe('search', () => {
    it('leaves out the formats a dataset document written before this still carries', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _id: 'pkg-1',
                _source: { name: 'old', join_field: 'package', formats: ['PDF'] },
                _score: 1,
              },
            ],
          },
        },
      })

      const result = await adapter.search({ q: '' })

      expect(result.items[0]).not.toHaveProperty('formats')
    })

    it('asks for the extras pairs on no hit, dataset or resource', async () => {
      mockClient.search.mockResolvedValue({ body: { hits: { total: { value: 0 }, hits: [] } } })

      await adapter.search({ q: 'x' })

      const body = mockClient.search.mock.calls[0][0].body
      expect(body._source).toEqual({ excludes: ['extras_pairs'] })
      expect(JSON.stringify(body.query)).toContain('"_source":{"excludes":["extras_pairs"]}')
    })

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
      // Text lifted out of a file must not outvote what a dataset says about
      // itself: one chunk of a free-text answer otherwise speaks for the whole
      // dataset, because the leg scores by its best chunk
      expect(must[2].has_child.boost).toBeLessThan(must[1].has_child.boost)
      expect(must[2].has_child.score_mode).toBe('max')
      expect(result.items).toHaveLength(1)
    })

    describe('minWords', () => {
      const hit = (id: string, matched?: string[]) => ({
        _id: id,
        _source: { name: id, join_field: 'package' },
        _score: 1,
        ...(matched && { matched_queries: matched }),
      })

      it('requires that many words, each held by any leg, and names the words a dataset lacks', async () => {
        mockClient.search.mockResolvedValue({
          body: {
            hits: {
              total: { value: 2 },
              hits: [hit('pkg-1', ['0', '2']), hit('pkg-2', ['1', '2'])],
            },
          },
        })

        const result = await adapter.search({ q: '都議選 投票率 2025', minWords: 2 })

        const query = mockClient.search.mock.calls[0][0].body.query.bool
        // One named filter a word, held where any leg holds it — the test that
        // admits a dataset is the one its missing words are read from
        const required = query.filter.at(-1).bool
        expect(required.minimum_should_match).toBe(2)
        expect(required.should.map((w: { bool: { _name: string } }) => w.bool._name)).toEqual([
          '0',
          '1',
          '2',
        ])
        // The legs only score, on any word
        const legs = query.must[0].bool.should
        expect(legs[0].bool.should).toHaveLength(3)
        expect(legs[0].bool.minimum_should_match).toBe(1)
        expect(legs[1].has_child.query.bool.minimum_should_match).toBe(1)
        expect(legs[2].has_child.query.bool.minimum_should_match).toBe(1)
        expect(result.minWords).toBe(2)
        expect(result.items.map((d) => d.missingWords)).toEqual([['投票率'], ['都議選']])
      })

      it('asks for every word as before when minWords is not fewer than the words', async () => {
        mockClient.search.mockResolvedValue({
          body: { hits: { total: { value: 1 }, hits: [hit('pkg-1')] } },
        })

        const result = await adapter.search({ q: '人口 推移', minWords: 2 })

        const query = mockClient.search.mock.calls[0][0].body.query.bool
        expect(query.must[0].bool.should[0].multi_match).toMatchObject({
          query: '人口 推移',
          operator: 'and',
        })
        expect(query.filter).toEqual([{ term: { join_field: 'package' } }])
        expect(result.minWords).toBeUndefined()
        expect(result.items[0]).not.toHaveProperty('missingWords')
      })
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

      it('reads a write as owed again when the backend was down or refused the credentials', () => {
        for (const err of [
          new osErrors.TimeoutError('timed out', meta(0)),
          new osErrors.ConnectionError('connection refused', meta(0)),
          new osErrors.NoLivingConnectionsError('none', meta(0)),
          new osErrors.ResponseError(meta(503)),
          new osErrors.ResponseError(meta(429)),
          new osErrors.ResponseError(meta(401)),
          new osErrors.ResponseError(meta(403)),
        ]) {
          expect(isSearchWriteUnavailable(err)).toBe(true)
        }
        // What was sent is refused, and would be every time
        for (const err of [
          new osErrors.ResponseError(meta(400)),
          new osErrors.ResponseError(meta(404)),
          new TypeError('cannot read property of undefined'),
          new Error('storage read failed'),
        ]) {
          expect(isSearchWriteUnavailable(err)).toBe(false)
        }
      })
    })

    it('does not count a content hit twice when the metadata hits it may be among went uncarried', async () => {
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
                  // 150 metadata matches, one carried: the content hit below may be one of the rest
                  resource: {
                    hits: {
                      total: { value: 150, relation: 'eq' },
                      hits: [{ _id: 'res-1', _source: { id: 'res-1', name: 'a.csv' } }],
                    },
                  },
                  content_hits: {
                    hits: {
                      hits: [{ _id: 'chunk-res2-0', _source: { resourceId: 'res-2' }, _score: 3 }],
                    },
                  },
                },
              },
            ],
          },
        },
      })
      mockClient.mget.mockResolvedValueOnce({
        body: { docs: [{ _id: 'res-2', found: true, _source: { name: 'b.csv' } }] },
      })

      const result = await adapter.search({ q: '人口', offset: 0, limit: 10 })

      expect(result.items[0].matchedResources).toHaveLength(2)
      expect(result.items[0].matchedResourcesCount).toEqual({ total: 150, atLeast: true })
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

    it("keeps a resource's best-scoring chunk when several of its chunks match", async () => {
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
                  resource: {
                    hits: { hits: [{ _id: 'res-1', _source: { id: 'res-1', name: 'a.pdf' } }] },
                  },
                  content_hits: {
                    hits: {
                      hits: [
                        { _id: 'chunk-res1-3', _source: { resourceId: 'res-1' }, _score: 4 },
                        { _id: 'chunk-res2-1', _source: { resourceId: 'res-2' }, _score: 3 },
                        { _id: 'chunk-res1-0', _source: { resourceId: 'res-1' }, _score: 2 },
                        { _id: 'chunk-res2-0', _source: { resourceId: 'res-2' }, _score: 1 },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      })
      mockClient.mget.mockResolvedValueOnce({
        body: { docs: [{ _id: 'res-2', found: true, _source: { name: 'b.pdf' } }] },
      })

      const result = await adapter.search({ q: '人口', offset: 0, limit: 10 })

      expect(
        result.items[0].matchedResources!.map(({ id, _contentDocId }) => ({ id, _contentDocId }))
      ).toEqual([
        { id: 'res-1', _contentDocId: 'chunk-res1-3' },
        { id: 'res-2', _contentDocId: 'chunk-res2-1' },
      ])
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

    it('filters on an updated range with either end open', async () => {
      mockClient.search.mockResolvedValue({
        body: { hits: { total: { value: 0 }, hits: [] } },
      })

      await adapter.search({
        q: '',
        filters: { updatedFrom: new Date('2026-01-02T03:04:05.000Z') },
      })

      const callArgs = mockClient.search.mock.calls[0][0]
      expect(callArgs.body.query.bool.filter).toEqual(
        expect.arrayContaining([{ range: { updated: { gte: '2026-01-02T03:04:05.000Z' } } }])
      )
    })

    it('filters formats through the resources, case-insensitively', async () => {
      mockClient.search.mockResolvedValue({
        body: { hits: { total: { value: 0 }, hits: [] } },
      })

      await adapter.search({ q: '', filters: { formats: ['geojson', 'CSV'] } })

      const callArgs = mockClient.search.mock.calls[0][0]
      expect(callArgs.body.query.bool.filter).toEqual(
        expect.arrayContaining(
          ['geojson', 'CSV'].map((value) => ({
            has_child: {
              type: 'resource',
              query: { term: { format: { value, case_insensitive: true } } },
            },
          }))
        )
      )
    })

    it('filters extras by pair: the dataset its own, each resource condition on some resource', async () => {
      mockClient.search.mockResolvedValue({
        body: { hits: { total: { value: 0 }, hits: [] } },
      })

      await adapter.search({
        q: '',
        filters: {
          extras: [{ key: 'a:b', value: 'x' }],
          resourceExtras: [
            { key: 'lang', value: 'ja' },
            { key: 'unit', value: 'city' },
          ],
        },
      })

      const callArgs = mockClient.search.mock.calls[0][0]
      expect(callArgs.body.query.bool.filter).toEqual(
        expect.arrayContaining([
          { term: { extras_pairs: '["a:b","x"]' } },
          ...[
            ['lang', 'ja'],
            ['unit', 'city'],
          ].map((pair) => ({
            has_child: {
              type: 'resource',
              query: { term: { extras_pairs: JSON.stringify(pair) } },
            },
          })),
        ])
      )
    })

    it('counts datasets per format from their resources, merging spellings', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: { total: { value: 0 }, hits: [] },
          aggregations: {
            organizations: { buckets: [] },
            tags: { buckets: [] },
            // An index from before the normalizer keeps the publisher's spelling
            formats: {
              doc_count: 9,
              byFormat: {
                buckets: [
                  { key: 'CSV', doc_count: 5, datasets: { doc_count: 3 } },
                  { key: 'GeoJSON', doc_count: 2, datasets: { doc_count: 1 } },
                  { key: 'GEOJSON', doc_count: 2, datasets: { doc_count: 2 } },
                ],
              },
            },
            licenses: { buckets: [] },
            groups: { buckets: [] },
          },
        },
      })

      const result = await adapter.search({ q: '', facets: true })

      const aggs = mockClient.search.mock.calls[0][0].body.aggs
      expect(aggs.formats).toEqual({
        children: { type: 'resource' },
        aggs: {
          byFormat: {
            // Ranked by datasets, so a format on many datasets with few files
            // each is not cut behind one on few datasets with many
            terms: {
              field: 'format',
              size: 200,
              order: [{ datasets: 'desc' }, { _key: 'asc' }],
            },
            aggs: { datasets: { parent: { type: 'resource' } } },
          },
        },
      })
      expect(result.facets?.formats).toEqual([
        { name: 'CSV', count: 3 },
        { name: 'GEOJSON', count: 3 },
      ])
    })

    it('should include aggregations when facets=true', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: { total: { value: 0 }, hits: [] },
          aggregations: {
            organizations: { buckets: [{ key: 'org-a', doc_count: 5 }] },
            tags: { buckets: [] },
            formats: { byFormat: { buckets: [] } },
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

      it('should sort by updated DESC when browsing, ending on the id', async () => {
        await adapter.search({ q: '' })
        const callArgs = mockClient.search.mock.calls[0][0]
        expect(callArgs.body.sort).toEqual([
          { updated: { order: 'desc' } },
          { id: { order: 'desc' } },
        ])
      })

      it('should sort a keyword search by score, then updated, then the id', async () => {
        await adapter.search({ q: 'x' })
        const callArgs = mockClient.search.mock.calls[0][0]
        expect(callArgs.body.sort).toEqual([
          '_score',
          { updated: { order: 'desc' } },
          { id: { order: 'desc' } },
        ])
      })

      it('should sort by specified field', async () => {
        await adapter.search({ q: '', sortBy: 'created', sortOrder: 'asc' })
        const callArgs = mockClient.search.mock.calls[0][0]
        expect(callArgs.body.sort).toEqual([
          { created: { order: 'asc' } },
          { id: { order: 'asc' } },
        ])
      })

      it('sorts by name on its keyword field', async () => {
        await adapter.search({ q: '', sortBy: 'name', sortOrder: 'asc' })
        const callArgs = mockClient.search.mock.calls[0][0]
        expect(callArgs.body.sort).toEqual([
          { 'name.keyword': { order: 'asc' } },
          { id: { order: 'asc' } },
        ])
      })

      it('sorts by id alone, which settles every tie', async () => {
        await adapter.search({ q: '', sortBy: 'id', sortOrder: 'asc' })
        const callArgs = mockClient.search.mock.calls[0][0]
        expect(callArgs.body.sort).toEqual([{ id: { order: 'asc' } }])
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

  describe('deleteResources', () => {
    it('deletes them all in one deleteByQuery', async () => {
      mockClient.deleteByQuery.mockResolvedValue({ body: {} })

      await adapter.deleteResources(['res-1', 'res-2'])

      expect(mockClient.deleteByQuery).toHaveBeenCalledOnce()
      expect(mockClient.deleteByQuery).toHaveBeenCalledWith({
        index: 'kukan-search',
        body: {
          query: {
            bool: {
              filter: [
                { ids: { values: ['res-1', 'res-2'] } },
                { term: { join_field: 'resource' } },
              ],
            },
          },
        },
        refresh: true,
      })
    })

    it('asks nothing for none', async () => {
      await adapter.deleteResources([])
      expect(mockClient.deleteByQuery).not.toHaveBeenCalled()
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

    it('names the documents the index refused, the others being written', async () => {
      mockClient.bulk.mockResolvedValue({
        body: {
          errors: true,
          items: [
            { index: { _id: 'res-1', status: 201 } },
            { index: { _id: 'res-2', status: 400, error: { type: 'mapper_parsing_exception' } } },
          ],
        },
      })

      const write = adapter.bulkIndexResources([
        { id: 'res-1', packageId: 'pkg-1' },
        { id: 'res-2', packageId: 'pkg-1' },
      ])

      await expect(write).rejects.toBeInstanceOf(BulkIndexError)
      await expect(write).rejects.toMatchObject({ failedIds: ['res-2'] })
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

      // Every tag but a bare <mark> comes out as text, not markup
      expect(result.items[0].highlightedTitle).toBe(
        '&lt;script&gt;alert(1)&lt;/script&gt;<mark>test</mark>'
      )
      expect(result.items[0].highlightedNotes).toBe('&lt;img onerror=alert(1)&gt;<mark>note</mark>')
    })

    it.each([
      ['<<b>img src=x onerror=alert(1)>', '&lt;&lt;b&gt;img src=x onerror=alert(1)&gt;'],
      [
        '<<a>a href=javascript:alert(1)>x</<a>a>',
        '&lt;&lt;a&gt;a href=javascript:alert(1)&gt;x&lt;/&lt;a&gt;a&gt;',
      ],
      ['<<mark>svg onload=alert(1)>', '&lt;<mark>svg onload=alert(1)&gt;'],
      ['<img src="a>b" onerror=alert(1)>', '&lt;img src=&quot;a&gt;b&quot; onerror=alert(1)&gt;'],
    ])('should leave no tag behind that removing another would make: %s', async (title, out) => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _id: 'pkg-1',
                _source: { name: 'test', join_field: 'package' },
                _score: 5,
                highlight: { title: [title] },
              },
            ],
          },
        },
      })

      const result = await adapter.search({ q: 'test' })

      expect(result.items[0].highlightedTitle).toBe(out)
      expect(result.items[0].highlightedTitle).not.toMatch(/<(?!\/?mark>)/)
    })

    it('should keep text that only looks like markup readable', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _id: 'pkg-1',
                _source: { name: 'test', join_field: 'package' },
                _score: 5,
                highlight: { title: ['A & B <mark>人口</mark> x<y'] },
              },
            ],
          },
        },
      })

      const result = await adapter.search({ q: '人口' })

      expect(result.items[0].highlightedTitle).toBe('A &amp; B <mark>人口</mark> x&lt;y')
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

      expect(result.items[0].highlightedTitle).toBe(
        '&lt;mark onmouseover=&quot;alert(1)&quot;&gt;test</mark>'
      )
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
      expect(matched.highlightedName).toBe('&lt;script&gt;x&lt;/script&gt;<mark>data</mark>.csv')
      // What the hit was on, and how many matched in all, ride along for the card
      expect(matched.matchedOn).toEqual(['name'])
      expect(result.items[0].matchedResourcesCount).toEqual({ total: 1, atLeast: false })
      // Content snippets are now fetched lazily via fetchContentHighlights
      expect(matched._contentDocId).toBe('chunk-res1-0')
    })

    it('carries the abstract back when the query matched it', async () => {
      // Without this the card shows a filename with nothing to say why it is a
      // hit: `matchedOn` names the abstract and the snippet that would explain
      // it was dropped in the response (ADR-053 §8.1).
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _id: 'pkg-1',
                _source: { name: 'test', join_field: 'package' },
                inner_hits: {
                  resource: {
                    hits: {
                      hits: [
                        {
                          _id: 'res-1',
                          _source: {
                            id: 'res-1',
                            packageId: 'pkg-1',
                            name: '13_shisetsu.csv',
                            summary: '全文。一致語はこの先にある。高齢者（お年寄り）向けの…',
                          },
                          highlight: {
                            summary: [
                              '…高齢者（<mark>お年寄り</mark>）向けの福祉施設の一覧である。',
                            ],
                          },
                        },
                      ],
                      total: { value: 1 },
                    },
                  },
                },
              },
            ],
          },
        },
      })

      const result = await adapter.search({ q: 'お年寄り' })

      const matched = result.items[0].matchedResources![0]
      expect(matched.matchedOn).toEqual(['summary'])
      // The fragment, not the whole abstract: an opening sentence says nothing
      // about a match further in, and nothing marked says nothing at all about
      // why this is a hit. Treated exactly as a description is.
      expect(matched.highlightedSummary).toBe(
        '…高齢者（<mark>お年寄り</mark>）向けの福祉施設の一覧である。'
      )
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

  describe('indexedDocumentIds', () => {
    it('pages the ids of one type from where the last page stopped', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          aggregations: {
            values: { buckets: [{ key: { value: 'r-2' } }, { key: { value: 'r-3' } }] },
          },
        },
      })

      const ids = await adapter.indexedDocumentIds('resource', 'r-1', 2)

      expect(ids).toEqual(['r-2', 'r-3'])
      const { body } = mockClient.search.mock.calls[0][0]
      expect(body.query).toEqual({ term: { join_field: 'resource' } })
      expect(body.aggs.values.composite).toEqual({
        size: 2,
        sources: [{ value: { terms: { field: 'id' } } }],
        after: { value: 'r-1' },
      })
    })
  })

  describe('indexedContentResources', () => {
    beforeEach(() => {
      mockClient.search.mockResolvedValue({
        body: { aggregations: { values: { buckets: [{ key: { value: 'r-1' } }] } } },
      })
    })

    it('lists every resource with content', async () => {
      expect(await adapter.indexedContentResources()).toEqual(['r-1'])
      const { body } = mockClient.search.mock.calls[0][0]
      expect(body.query).toEqual({ term: { join_field: 'content' } })
    })
  })

  describe('countIndexedContentResources', () => {
    it('counts the resources with a larger chunk in one request', async () => {
      mockClient.search.mockResolvedValue({
        body: { aggregations: { resources: { value: 60 } } },
      })

      expect(await adapter.countIndexedContentResources({ chunkedAbove: 65_536 })).toBe(60)
      const { body } = mockClient.search.mock.calls[0][0]
      expect(body.query.bool.filter).toContainEqual({ range: { chunkSize: { gt: 65_536 } } })
      expect(body.aggs.resources.cardinality.field).toBe('resourceId')
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

  describe('fetchContentPassages', () => {
    const options = { fragmentChars: 1200, fragmentsPerChunk: 3, chunksPerResource: 2 }

    it("cuts each resource's best chunks by the highlighter, with the chunk they are from", async () => {
      mockClient.search.mockResolvedValueOnce({
        body: {
          hits: {
            hits: [
              {
                _id: 'res-1_chunk_0',
                inner_hits: {
                  chunks: {
                    hits: {
                      hits: [
                        {
                          _score: 4.2,
                          _source: { resourceId: 'res-1', chunkIndex: 2 },
                          highlight: { extractedText: ['\uE000汚泥\uE001は', '\uE000処理\uE001'] },
                        },
                        // A chunk the highlighter found nothing to mark in
                        { _score: 1, _source: { resourceId: 'res-1', chunkIndex: 0 } },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      })

      const hits = await adapter.fetchContentPassages(['res-1', 'res-2'], '汚泥の処理', options, {
        excludePrivate: true,
      })

      expect(hits).toEqual([
        {
          resourceId: 'res-1',
          chunkIndex: 2,
          fragments: ['\uE000汚泥\uE001は', '\uE000処理\uE001'],
        },
      ])
      const { body } = mockClient.search.mock.calls[0][0]
      // Any word makes a passage: not every one of them need be in it
      expect(body.query.bool.must).toEqual({ match: { extractedText: { query: '汚泥の処理' } } })
      expect(body.query.bool.filter).toEqual(
        expect.arrayContaining([
          { terms: { resourceId: ['res-1', 'res-2'] } },
          { term: { join_field: 'content' } },
        ])
      )
      // The caller's visibility, at the dataset
      expect(JSON.stringify(body.query.bool.filter)).toContain('has_parent')
      expect(body.collapse.field).toBe('resourceId')
      expect(body.collapse.inner_hits.size).toBe(2)
      expect(body.collapse.inner_hits.highlight.fields.extractedText).toMatchObject({
        type: 'unified',
        fragment_size: 1200,
        number_of_fragments: 3,
        order: 'score',
        pre_tags: ['\uE000'],
        post_tags: ['\uE001'],
      })
    })

    it('asks nothing of the index for no resources', async () => {
      expect(await adapter.fetchContentPassages([], 'test', options)).toEqual([])
      expect(mockClient.search).not.toHaveBeenCalled()
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

    it('marks the words a chunk holds, though it may hold only some of them', async () => {
      mockClient.search.mockResolvedValueOnce({ body: { hits: { hits: [] } } })

      await adapter.fetchContentHighlights(['chunk-1'], '人口 火星')

      const must = mockClient.search.mock.calls[0][0].body.query.bool.must
      expect(must).toEqual({ match: { extractedText: { query: '人口 火星' } } })
    })

    it('starts a snippet near its first match, from the line when that is near', async () => {
      const far = 'あ'.repeat(200)
      mockClient.search.mockResolvedValueOnce({
        body: {
          hits: {
            hits: [
              { _id: 'chunk-1', highlight: { extractedText: [`${far}<mark>子育て</mark>支援`] } },
              {
                _id: 'chunk-2',
                highlight: { extractedText: [`${far}\n名称: 東<mark>子育て</mark>広場`] },
              },
            ],
          },
        },
      })

      const result = await adapter.fetchContentHighlights(['chunk-1', 'chunk-2'], '子育て')

      expect(result).toEqual({
        'chunk-1': `…${'あ'.repeat(60)}<mark>子育て</mark>支援`,
        'chunk-2': '…名称: 東<mark>子育て</mark>広場',
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
      expect(result['chunk-1']).toBe('&lt;script&gt;alert(1)&lt;/script&gt;<mark>data</mark>')
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

  describe('reanalyseIndex', () => {
    /** The analysis the code defines */
    const liveAnalysis = () =>
      (OpenSearchAdapter as unknown as { KUROMOJI_ANALYSIS: { analysis: unknown } })
        .KUROMOJI_ANALYSIS.analysis

    /** As the cluster answers: every value a string and the keys in its own
     *  order, both of which the comparison has to see past */
    function settingsBody(analysis: unknown) {
      const asCluster = (v: unknown): unknown =>
        Array.isArray(v)
          ? v.map(asCluster)
          : v && typeof v === 'object'
            ? Object.fromEntries(
                Object.entries(v as Record<string, unknown>)
                  .reverse()
                  .map(([k, x]) => [k, asCluster(x)])
              )
            : String(v)
      return {
        body: { 'kukan-search-000001': { settings: { index: { analysis: asCluster(analysis) } } } },
      }
    }

    beforeEach(() => {
      // These all act on a deployment whose index is already there
      mockClient.indices.exists.mockResolvedValue({ body: true })
      mockClient.indices.delete.mockResolvedValue({ body: {} })
      // Re-set each time: the outer `clearAllMocks` clears calls, not the
      // implementations a previous case installed
      mockClient.indices.getSettings.mockResolvedValue({ body: {} })
      mockClient.indices.getMapping.mockResolvedValue({ body: {} })
      mockClient.indices.putMapping.mockResolvedValue({ body: {} })
      mockClient.indices.updateAliases.mockResolvedValue({ body: {} })
      mockClient.reindex.mockResolvedValue({ body: { task: 'node:42' } })
      mockClient.tasks.get.mockResolvedValue({
        body: { completed: true, response: { total: 7, created: 7, failures: [] } },
      })
      mockClient.tasks.cancel.mockResolvedValue({ body: {} })
      mockClient.indices.getMapping.mockResolvedValue({ body: {} })
    })

    it('reports the analysis as current when it is the one the code defines', async () => {
      mockClient.indices.getSettings.mockResolvedValue(settingsBody(liveAnalysis()))

      expect(await adapter.analysisStale()).toBe(false)
    })

    it('reports the analysis as stale when the live index was built under another', async () => {
      const analysis = liveAnalysis() as {
        analyzer: { kuromoji_analyzer: { filter: string[] } }
      }
      const older = structuredClone(analysis)
      older.analyzer.kuromoji_analyzer.filter = older.analyzer.kuromoji_analyzer.filter.filter(
        (f) => f !== 'ja_prefix'
      )
      mockClient.indices.getSettings.mockResolvedValue(settingsBody(older))

      expect(await adapter.analysisStale()).toBe(true)
    })

    it('says it cannot tell, rather than answer for a cluster it cannot read', async () => {
      mockClient.indices.getSettings.mockRejectedValue(new Error('connection refused'))

      // A screen may choose to say nothing; a job must not read silence as
      // "already current" and then acknowledge its message
      await expect(adapter.analysisStale()).rejects.toThrow('connection refused')
    })

    /** The index a run created to copy into */
    const destinationOf = (calls: unknown[][]) => (calls.at(-1)![0] as { index: string }).index

    it('copies into the next index and swaps the alias in one step', async () => {
      const result = await adapter.reanalyseIndex()
      const to = destinationOf(mockClient.indices.create.mock.calls)

      expect(result).toEqual({ from: 'kukan-search-000001', to, documents: 7 })
      expect(to).toMatch(/^kukan-search-000002-[0-9a-f]{8}$/)
      expect(mockClient.indices.create).toHaveBeenCalledWith({
        index: to,
        body: expect.objectContaining({
          settings: expect.objectContaining({ analysis: expect.anything() }),
        }),
      })
      // `must_exist`, or an attempt whose alias has already moved removes
      // nothing, adds itself beside the winner, and the name stops taking writes
      expect(mockClient.indices.updateAliases).toHaveBeenCalledWith({
        body: {
          actions: [
            { remove: { index: 'kukan-search-000001', alias: 'kukan-search', must_exist: true } },
            { add: { index: to, alias: 'kukan-search' } },
          ],
        },
      })
      // Only once the alias no longer points at it
      expect(mockClient.indices.delete.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
        mockClient.indices.updateAliases.mock.invocationCallOrder[0]
      )
    })

    it('waits on the copy as a task, not as one long request', async () => {
      mockClient.tasks.get
        .mockResolvedValueOnce({ body: { completed: false } })
        .mockResolvedValueOnce({
          body: { completed: true, response: { total: 7, created: 7, failures: [] } },
        })
      vi.useFakeTimers()
      try {
        const copying = adapter.reanalyseIndex()
        await vi.advanceTimersByTimeAsync(10_000)
        const result = await copying

        // Polled, rather than asking the cluster to hold one request open: a
        // copy still running answers that with a 500 the transport raises
        expect(mockClient.reindex.mock.calls[0][0].wait_for_completion).toBe(false)
        // The copy leaves behind the formats dataset documents once carried
        expect(mockClient.reindex.mock.calls[0][0].body.script.source).toBe(
          "ctx._source.remove('formats')"
        )
        expect(mockClient.tasks.get.mock.calls[0][0].wait_for_completion).toBeUndefined()
        expect(mockClient.tasks.get).toHaveBeenCalledTimes(2)
        expect(result?.documents).toBe(7)
      } finally {
        vi.useRealTimers()
      }
    })

    it('treats a copy that was cancelled part-way as a failed copy', async () => {
      // `completed`, no `error`, no `failures` — and 6 of 50 documents
      mockClient.tasks.get.mockResolvedValue({
        body: { completed: true, response: { total: 50, created: 6, failures: [] } },
      })

      await expect(adapter.reanalyseIndex()).rejects.toThrow('failures')

      expect(mockClient.indices.updateAliases).not.toHaveBeenCalled()
    })

    it('follows the number of an index created before the suffix existed', async () => {
      // Re-using that number would collide with the index still holding it
      await adapter.reanalyseIndex()

      expect(destinationOf(mockClient.indices.create.mock.calls)).toMatch(
        /^kukan-search-000002-[0-9a-f]{8}$/
      )
    })

    it('copies into a name no other attempt would compute', async () => {
      await adapter.reanalyseIndex()
      const first = destinationOf(mockClient.indices.create.mock.calls)
      mockClient.indices.create.mockClear()
      await adapter.reanalyseIndex()

      // Two attempts that shared a destination would have to agree about who
      // owns it, and every way of asking leaves a window in which one deletes
      // what the other is filling
      expect(destinationOf(mockClient.indices.create.mock.calls)).not.toBe(first)
    })

    it('records on the new index the window its copy could not see', async () => {
      await adapter.reanalyseIndex()

      const created = mockClient.indices.create.mock.calls.at(-1)
      expect(
        (
          created![0] as {
            body: { mappings: { _meta?: { reanalyse?: { copyStartedAt?: string } } } }
          }
        ).body.mappings._meta?.reanalyse?.copyStartedAt
      ).toEqual(expect.any(String))
    })

    it('reports a repair still owed by the live index', async () => {
      mockClient.indices.getMapping.mockResolvedValue({
        body: {
          'kukan-search-000001': {
            mappings: { _meta: { reanalyse: { copyStartedAt: '2026-09-17T10:00:00.000Z' } } },
          },
        },
      })

      expect(await adapter.pendingRepair()).toEqual(new Date('2026-09-17T10:00:00.000Z'))
    })

    it('owes nothing once the repair is recorded', async () => {
      mockClient.indices.getMapping.mockResolvedValue({
        body: {
          'kukan-search-000001': {
            mappings: {
              _meta: {
                reanalyse: {
                  copyStartedAt: '2026-09-17T10:00:00.000Z',
                  repairedAt: '2026-09-17T10:05:00.000Z',
                },
              },
            },
          },
        },
      })

      expect(await adapter.pendingRepair()).toBeNull()
      await adapter.markRepaired()
      expect(mockClient.indices.putMapping).not.toHaveBeenCalled()
    })

    it('deletes an index no attempt could still be filling', async () => {
      const old = Date.now() - 2 * 60 * 60_000
      mockClient.indices.getSettings.mockResolvedValue({
        body: {
          'kukan-search-000001': { settings: { index: { creation_date: String(old) } } },
          'kukan-search-000002-dead': { settings: { index: { creation_date: String(old) } } },
          'kukan-search-000002-live': {
            settings: { index: { creation_date: String(Date.now() - 5_000) } },
          },
        },
      })

      await adapter.reanalyseIndex()

      const deleted = mockClient.indices.delete.mock.calls.map(
        (c: unknown[]) => (c[0] as { index: string }).index
      )
      expect(deleted).toContain('kukan-search-000002-dead')
      // Young enough that an attempt may still be filling it
      expect(deleted).not.toContain('kukan-search-000002-live')
    })

    /** Minimal meta for constructing an OpenSearch client error */
    const errorMeta = (statusCode: number) =>
      ({
        body: {},
        statusCode,
        headers: {},
        warnings: null,
        meta: {},
      }) as unknown as ConstructorParameters<typeof osErrors.ResponseError>[0]

    it('leaves the copy alone when the swap may yet be applied', async () => {
      // A timeout is not an answer. The cluster may still be applying the
      // action list, and the index deleted here is the one it would swap to.
      mockClient.indices.updateAliases.mockRejectedValue(
        new osErrors.TimeoutError('timed out', errorMeta(0))
      )

      await expect(adapter.reanalyseIndex()).rejects.toThrow()

      expect(mockClient.indices.delete).not.toHaveBeenCalled()
    })

    it('leaves the copy alone when the cluster answered with a server error', async () => {
      mockClient.indices.updateAliases.mockRejectedValue(new osErrors.ResponseError(errorMeta(503)))

      await expect(adapter.reanalyseIndex()).rejects.toThrow()

      expect(mockClient.indices.delete).not.toHaveBeenCalled()
    })

    it('clears the copy when the cluster refused the swap outright', async () => {
      // A 4xx is an answer: the action list was rejected and nothing moved
      mockClient.indices.updateAliases.mockRejectedValue(new osErrors.ResponseError(errorMeta(404)))

      await expect(adapter.reanalyseIndex()).rejects.toThrow()

      expect(
        mockClient.indices.delete.mock.calls.map(
          (c: unknown[]) => (c[0] as { index: string }).index
        )
      ).toEqual([destinationOf(mockClient.indices.create.mock.calls)])
    })

    it('clears the copy when it failed before the swap was ever asked for', async () => {
      mockClient.tasks.get.mockResolvedValue({
        body: { completed: true, response: { total: 6, created: 5, failures: [] } },
      })

      await expect(adapter.reanalyseIndex()).rejects.toThrow('failures')

      expect(
        mockClient.indices.delete.mock.calls.map(
          (c: unknown[]) => (c[0] as { index: string }).index
        )
      ).toEqual([destinationOf(mockClient.indices.create.mock.calls)])
      expect(mockClient.indices.updateAliases).not.toHaveBeenCalled()
    })

    it('treats a failure to delete the replaced index as housekeeping', async () => {
      // The alias is already on the new index, so this is a leftover for the
      // next run's sweep — not a reason to fail a re-analysis that worked
      mockClient.indices.delete.mockRejectedValue(new Error('still merging'))

      await expect(adapter.reanalyseIndex()).resolves.toMatchObject({
        from: 'kukan-search-000001',
      })
    })

    it('raises a destination it could not create', async () => {
      mockClient.indices.create.mockRejectedValue(
        Object.assign(new Error('bad mapping'), {
          meta: { body: { error: { type: 'mapper_parsing_exception' } } },
        })
      )

      await expect(adapter.reanalyseIndex()).rejects.toThrow('bad mapping')
    })

    it('gives up on a copy that never finishes, and keeps the live index', async () => {
      vi.useFakeTimers()
      try {
        mockClient.tasks.get.mockImplementation(async () => {
          vi.setSystemTime(Date.now() + 61 * 60_000)
          return { body: { completed: false } }
        })

        await expect(adapter.reanalyseIndex()).rejects.toThrow('did not finish in time')

        expect(mockClient.tasks.cancel).toHaveBeenCalledWith({ task_id: 'node:42' })
        expect(mockClient.indices.updateAliases).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('migrates a deployment that predates the alias in one request', async () => {
      mockClient.indices.existsAlias.mockResolvedValue({ body: false })

      const result = await adapter.reanalyseIndex()

      expect(result?.from).toBe('kukan-search')
      expect(result.to).toMatch(/^kukan-search-000001-[0-9a-f]{8}$/)
      // An index and an alias cannot share a name, and `remove_index` drops the
      // old one inside the same action list that adds the alias — so the name
      // never resolves to nothing
      expect(mockClient.indices.updateAliases).toHaveBeenCalledWith({
        body: {
          actions: [
            { remove_index: { index: 'kukan-search' } },
            { add: { index: result.to, alias: 'kukan-search' } },
          ],
        },
      })
      expect(
        mockClient.indices.delete.mock.calls.map(
          (c: unknown[]) => (c[0] as { index: string }).index
        )
      ).not.toContain('kukan-search')
    })

    it('keeps the live index when the copy loses documents', async () => {
      mockClient.tasks.get.mockResolvedValue({
        body: { completed: true, response: { total: 6, created: 5, failures: [{ cause: 'x' }] } },
      })

      await expect(adapter.reanalyseIndex()).rejects.toThrow('failures')

      expect(mockClient.indices.updateAliases).not.toHaveBeenCalled()
      const deleted = mockClient.indices.delete.mock.calls.map(
        (c: unknown[]) => (c[0] as { index: string }).index
      )
      // Its own destination, and nothing else
      expect(deleted).toEqual([destinationOf(mockClient.indices.create.mock.calls)])
    })
  })
})
