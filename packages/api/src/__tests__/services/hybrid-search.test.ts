import { describe, it, expect, vi } from 'vitest'
import { createMockDb } from '../test-helpers/mock-db'
import { hybridSearch, fuseRrf } from '../../services/hybrid-search'
import type { SearchAdapter, SearchResult, DatasetDoc } from '@kukan/search-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'
import type { Logger } from '@kukan/shared'
import type { Database } from '@kukan/db'

const logger = { warn: vi.fn(), error: vi.fn() } as unknown as Logger

function bm25Result(ids: string[], total = ids.length): SearchResult {
  return {
    items: ids.map((id) => ({ id, name: `pkg-${id}` }) as DatasetDoc),
    total,
    offset: 0,
    limit: 50,
  }
}

function makeSearch(result: SearchResult) {
  return { search: vi.fn().mockResolvedValue(result) } as unknown as SearchAdapter
}

function makeDbSearch(hits: Array<{ id: string; similarity: number }>) {
  return {
    searchByVector: vi.fn().mockResolvedValue(hits),
  } as unknown as SearchAdapter
}

function makeAI(opts?: { available?: boolean; failEmbed?: boolean }) {
  return {
    getEmbeddingInfo: () =>
      opts?.available === false ? null : { model: 'test-model', dimensions: 3 },
    embed: opts?.failEmbed
      ? vi.fn().mockRejectedValue(new Error('embed down'))
      : vi.fn().mockResolvedValue([1, 0, 0]),
  } as unknown as AIAdapter
}

function deps(over: Partial<Parameters<typeof hybridSearch>[0]> = {}) {
  const { db } = createMockDb()
  return {
    db: db as unknown as Database,
    search: makeSearch(bm25Result(['a', 'b'])),
    dbSearch: makeDbSearch([]),
    ai: makeAI(),
    logger,
    ...over,
  }
}

describe('fuseRrf', () => {
  it('ranks a doc found by both lists above single-list docs', () => {
    expect(fuseRrf(['a', 'b'], ['b', 'c'])).toEqual(['b', 'a', 'c'])
  })

  it('handles an empty vector list', () => {
    expect(fuseRrf(['a', 'b'], [])).toEqual(['a', 'b'])
  })
})

describe('hybridSearch — degrade paths (BM25 passthrough)', () => {
  it('passes through when semantic=false', async () => {
    const d = deps()
    await hybridSearch(d, { q: 'q-semantic-false', offset: 5, limit: 10, semantic: false })
    expect(d.search.search).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'q-semantic-false', offset: 5, limit: 10 })
    )
    expect(d.dbSearch.searchByVector).not.toHaveBeenCalled()
  })

  it('passes through when embedding is unavailable (NoOp)', async () => {
    const d = deps({ ai: makeAI({ available: false }) })
    await hybridSearch(d, { q: 'q-noop' })
    expect(d.dbSearch.searchByVector).not.toHaveBeenCalled()
  })

  it('passes through for empty queries (browse)', async () => {
    const d = deps()
    await hybridSearch(d, { q: '  ' })
    expect(d.dbSearch.searchByVector).not.toHaveBeenCalled()
  })

  it('passes through for explicit sorts', async () => {
    const d = deps()
    await hybridSearch(d, { q: 'q-sort', sortBy: 'name' })
    expect(d.dbSearch.searchByVector).not.toHaveBeenCalled()
  })

  it('passes through beyond the fusion window', async () => {
    const d = deps()
    await hybridSearch(d, { q: 'q-deep-page', offset: 40, limit: 20 })
    expect(d.dbSearch.searchByVector).not.toHaveBeenCalled()
    expect(d.search.search).toHaveBeenCalledWith(expect.objectContaining({ offset: 40, limit: 20 }))
  })

  it('degrades to BM25 when query embedding fails (request still succeeds)', async () => {
    const d = deps({ ai: makeAI({ failEmbed: true }) })
    const result = await hybridSearch(d, { q: 'q-embed-fail', limit: 20 })
    expect(result.items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(d.dbSearch.searchByVector).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('degrades to BM25 when vector search throws', async () => {
    const d = deps({
      dbSearch: {
        searchByVector: vi.fn().mockRejectedValue(new Error('pg down')),
      } as unknown as SearchAdapter,
    })
    const result = await hybridSearch(d, { q: 'q-vector-fail', limit: 20 })
    expect(result.items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('hybridSearch — fusion', () => {
  it('fuses BM25 and vector hits with RRF and marks semantic-only docs', async () => {
    const { db, addResult } = createMockDb()
    // fetchSemanticDocs query for the vector-only id 'c'
    addResult([{ id: 'c', name: 'pkg-c', title: 'C', notes: null, organization: 'org-1' }])
    const d = deps({
      db: db as unknown as Database,
      search: makeSearch(bm25Result(['a', 'b'], 10)),
      dbSearch: makeDbSearch([
        { id: 'b', similarity: 0.9 },
        { id: 'c', similarity: 0.8 },
      ]),
    })

    const result = await hybridSearch(d, { q: 'q-fusion', offset: 0, limit: 20 })

    // 'b' is in both lists → first; 'a' (BM25 rank 1) before 'c' (vector rank 2)
    expect(result.items.map((i) => i.id)).toEqual(['b', 'a', 'c'])
    expect(result.items[2]).toMatchObject({ matchSource: 'semantic', title: 'C' })
    expect(result.items[0].matchSource).toBeUndefined()
    expect(result.total).toBe(10)
    // BM25 leg is fetched with the full fusion window, not the requested page
    expect(d.search.search).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, limit: 50 }))
  })

  it('applies offset/limit to the fused list and grows total when needed', async () => {
    // Requested page ['a'] contains no semantic-only hit → no DB fetch queued
    const d = deps({
      search: makeSearch(bm25Result(['a', 'b'], 2)),
      dbSearch: makeDbSearch([
        { id: 'b', similarity: 0.9 },
        { id: 'c', similarity: 0.8 },
      ]),
    })

    const result = await hybridSearch(d, { q: 'q-paging', offset: 1, limit: 1 })

    expect(result.items.map((i) => i.id)).toEqual(['a'])
    expect(result.offset).toBe(1)
    expect(result.limit).toBe(1)
    // 2 BM25 + 1 semantic-only → fused count exceeds the BM25 total
    expect(result.total).toBe(3)
  })

  it('caches the query embedding across calls', async () => {
    const d = deps({
      search: makeSearch(bm25Result(['a'])),
      dbSearch: makeDbSearch([{ id: 'a', similarity: 0.9 }]),
    })
    await hybridSearch(d, { q: 'q-cache-hit' })
    await hybridSearch(d, { q: 'q-cache-hit' })
    expect(d.ai.embed).toHaveBeenCalledTimes(1)
  })
})
