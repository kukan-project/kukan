import { describe, it, expect, vi } from 'vitest'
import { createMockDb } from '../test-helpers/mock-db'
import { hybridSearch, fuseRrf, mergeFacets, vectorVoteWeight } from '../../services/hybrid-search'
import {
  VECTOR_SIMILARITY_NOTCHES_KEY,
  SEMANTIC_SEARCH_ENABLED_KEY,
  type SettingKey,
  type SystemSettingService,
} from '../../services/system-setting'
import type { SearchAdapter, SearchResult, SearchFacets, DatasetDoc } from '@kukan/search-adapter'
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

function makeAI(opts?: { available?: boolean; failEmbed?: boolean; dimensions?: number }) {
  return {
    getEmbeddingInfo: () =>
      opts?.available === false ? null : { model: 'test-model', dimensions: opts?.dimensions ?? 3 },
    embed: opts?.failEmbed
      ? vi.fn().mockRejectedValue(new Error('embed down'))
      : vi.fn().mockResolvedValue([1, 0, 0]),
  } as unknown as AIAdapter
}

function makeSettings(over?: { notches?: number; semanticEnabled?: boolean }) {
  const values: Partial<Record<SettingKey, unknown>> = {
    [VECTOR_SIMILARITY_NOTCHES_KEY]: over?.notches ?? 0,
    [SEMANTIC_SEARCH_ENABLED_KEY]: over?.semanticEnabled ?? true,
  }
  return {
    getSetting: vi.fn(async (key: SettingKey) => values[key]),
  } as unknown as SystemSettingService
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

const emptyFacets: SearchFacets = {
  organizations: [],
  groups: [],
  tags: [],
  formats: [],
  licenses: [],
}

describe('mergeFacets', () => {
  it('sums buckets by name and sorts by count', () => {
    const merged = mergeFacets(
      {
        ...emptyFacets,
        organizations: [{ name: 'org-a', count: 1 }],
        tags: [{ name: 'stats', count: 2 }],
      },
      {
        ...emptyFacets,
        organizations: [
          { name: 'org-a', count: 1 },
          { name: 'org-b', count: 3 },
        ],
      }
    )
    expect(merged.organizations).toEqual([
      { name: 'org-b', count: 3 },
      { name: 'org-a', count: 2 },
    ])
    expect(merged.tags).toEqual([{ name: 'stats', count: 2 }])
  })

  it('returns the addition when the base is undefined', () => {
    const add = { ...emptyFacets, tags: [{ name: 't', count: 1 }] }
    expect(mergeFacets(undefined, add)).toBe(add)
  })
})

const full = (...ids: string[]) => ids.map((id) => ({ id, weight: 1 }))

describe('fuseRrf', () => {
  it('ranks a doc found by both lists above single-list docs', () => {
    // And a confident vector hit above a keyword-only one, which is what the
    // leg weight buys: a paraphrase query scores 0% on the keyword leg, so a
    // vote of equal size cannot carry its answer past documents BM25 merely
    // happened to match.
    expect(fuseRrf(['a', 'b'], full('b', 'c'))).toEqual(['b', 'c', 'a'])
  })

  it('keeps a keyword-only doc above a vector hit far down the window', () => {
    // The weight reaches the top of the vector list, not all of it. Without
    // that bound every vector hit in the window outranks the best keyword hit.
    const far = Array.from({ length: 20 }, (_, i) => `v${i}`)
    const fused = fuseRrf(['a'], full(...far))
    expect(fused.indexOf('a')).toBeLessThan(fused.indexOf('v19'))
  })

  it('handles an empty vector list', () => {
    expect(fuseRrf(['a', 'b'], [])).toEqual(['a', 'b'])
  })

  it('lets a near-floor vector vote lift nothing', () => {
    // The shape a short everyday query takes: BM25 found the relevant doc at 1
    // and an incidental one far down; the vector leg cleared the floor on that
    // incidental doc alone. At full weight the second signal lifts it to the
    // top of everything. Weighed by a thin margin it climbs a little — RRF's
    // ranks are close together — but not past the relevant doc.
    //
    // **This is what ties RRF_K to VECTOR_LEG_WEIGHT.** Weighting the leg over
    // the flat rank curve K=60 gave would have let a 0.064 vote do it; the
    // steeper curve raises the threshold to 0.225 instead.
    const bm25 = ['rel', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'inc']
    expect(fuseRrf(bm25, full('inc'))[0]).toBe('inc')
    const damped = fuseRrf(bm25, [{ id: 'inc', weight: 0.1 }])
    expect(damped[0]).toBe('rel')
    expect(damped.indexOf('inc')).toBeGreaterThan(damped.indexOf('x1'))
  })
})

describe('vectorVoteWeight', () => {
  it('rises from nothing at the floor to a full vote one ramp above it', () => {
    expect(vectorVoteWeight(0.3, 0.3)).toBe(0)
    expect(vectorVoteWeight(0.4, 0.3)).toBeCloseTo(0.5)
    expect(vectorVoteWeight(0.5, 0.3)).toBe(1)
    expect(vectorVoteWeight(0.9, 0.3)).toBe(1)
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

  it('reports what it did, so a caller can tell degrading from finding nothing', async () => {
    // The two look identical from the outside: a vector leg that ran and
    // cleared nothing returns the same empty list as one whose embedding
    // failed. An evaluation run that cannot tell them apart reports a
    // keyword-only run as hybrid, which happened twice in one afternoon.
    const ok = await hybridSearch(deps(), { q: 'q-fine' })
    expect(ok.semantic).toBe('applied')

    const broken = await hybridSearch(deps({ ai: makeAI({ failEmbed: true }) }), { q: 'q-broken' })
    expect(broken.semantic).toBe('degraded')

    const off = await hybridSearch(deps(), { q: 'q-off', semantic: false })
    expect(off.semantic).toBe('off')
  })

  it('calls a leg that cleared nothing applied, not degraded', async () => {
    // A short query clears the similarity floor on nothing at all — "お年寄り"
    // did, against every package in a live catalogue. That is the search
    // working, and must not read as a failure.
    const d = deps()
    vi.mocked(d.dbSearch.searchByVector!).mockResolvedValue([])

    expect((await hybridSearch(d, { q: 'q-nothing-clears' })).semantic).toBe('applied')
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

  it('passes through when the page starts beyond any possible fused list', async () => {
    const d = deps()
    await hybridSearch(d, { q: 'q-deep-page', offset: 100, limit: 20 })
    expect(d.dbSearch.searchByVector).not.toHaveBeenCalled()
    expect(d.search.search).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 100, limit: 20 })
    )
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

    // 'b' is in both lists → first; then 'c', a confident vector hit, over 'a',
    // which only the keyword leg found (VECTOR_LEG_WEIGHT)
    expect(result.items.map((i) => i.id)).toEqual(['b', 'c', 'a'])
    expect(result.items[1]).toMatchObject({ matchSource: 'semantic', title: 'C' })
    expect(result.items[0].matchSource).toBeUndefined()
    expect(result.total).toBe(10)
    // BM25 leg is fetched with the full fusion window, not the requested page
    expect(d.search.search).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, limit: 50 }))
    // The vector leg filters by the full vector-space key, not the bare model name
    expect(d.dbSearch.searchByVector).toHaveBeenCalledWith(
      [1, 0, 0],
      'test-model@3',
      expect.anything(),
      50,
      undefined
    )
  })

  it('namespaces the query-embedding cache by dimension', async () => {
    const dims3 = makeAI({ dimensions: 3 })
    const dims4 = makeAI({ dimensions: 4 })
    const legs = () => ({
      search: makeSearch(bm25Result(['a'])),
      dbSearch: makeDbSearch([{ id: 'a', similarity: 0.9 }]),
    })

    await hybridSearch(deps({ ...legs(), ai: dims3 }), { q: 'q-cache-dims' })
    await hybridSearch(deps({ ...legs(), ai: dims4 }), { q: 'q-cache-dims' })

    // A dimension change must not reuse the other dimension's cached vector
    expect(dims3.embed).toHaveBeenCalledTimes(1)
    expect(dims4.embed).toHaveBeenCalledTimes(1)
  })

  it('applies offset/limit to the fused list and grows total when needed', async () => {
    // fused = [b, c, a]; the requested page ['a'] holds no semantic-only hit,
    // so no DB fetch is queued for it
    const d = deps({
      search: makeSearch(bm25Result(['a', 'b'], 2)),
      dbSearch: makeDbSearch([
        { id: 'b', similarity: 0.9 },
        { id: 'c', similarity: 0.8 },
      ]),
    })

    const result = await hybridSearch(d, { q: 'q-paging', offset: 2, limit: 1 })

    expect(result.items.map((i) => i.id)).toEqual(['a'])
    expect(result.offset).toBe(2)
    expect(result.limit).toBe(1)
    // 2 BM25 + 1 semantic-only → fused count exceeds the BM25 total
    expect(result.total).toBe(3)
  })

  it('serves fused pages past the old fusion-window boundary (total stays consistent)', async () => {
    // Regression: total=52 (2 BM25 + 50 semantic) once promised page 3, but
    // offset 40 degraded to keyword-only (total 2) and returned a dead page.
    const { db, addResult } = createMockDb()
    const vectorIds = Array.from({ length: 50 }, (_, i) => `v${i}`)
    // fused = [a, v0, b, v1, ...] → page [40, 60) is v38..v49, all semantic-only
    addResult(
      vectorIds
        .slice(38)
        .map((id) => ({ id, name: `pkg-${id}`, title: null, notes: null, organization: null }))
    )
    const d = deps({
      db: db as unknown as Database,
      search: makeSearch(bm25Result(['a', 'b'], 2)),
      dbSearch: makeDbSearch(vectorIds.map((id, i) => ({ id, similarity: 0.9 - i * 0.001 }))),
    })

    const result = await hybridSearch(d, { q: 'q-deep-fused', offset: 40, limit: 20 })

    expect(result.total).toBe(52)
    expect(result.items).toHaveLength(12)
    expect(result.items.every((i) => i.matchSource === 'semantic')).toBe(true)
  })

  it('falls back to keyword paging when the page starts beyond the fused list', async () => {
    const d = deps({
      search: makeSearch(bm25Result(['a', 'b'], 200)),
      dbSearch: makeDbSearch([{ id: 'b', similarity: 0.9 }]),
    })

    const result = await hybridSearch(d, { q: 'q-past-fused', offset: 10, limit: 10 })

    // Fused list is only 2 ids but keyword matches continue — page in keyword order
    expect(d.search.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 10, limit: 10 })
    )
    expect(result.total).toBe(200)
  })

  it('merges vector-only hit facets into the BM25 facets when requested', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ id: 'c', name: 'pkg-c', title: null, notes: null, organization: null }])
    const bm25 = bm25Result(['a'], 1)
    bm25.facets = { ...emptyFacets, organizations: [{ name: 'org-a', count: 1 }] }
    const facetsForIds = vi
      .fn()
      .mockResolvedValue({ ...emptyFacets, organizations: [{ name: 'org-c', count: 1 }] })
    const d = deps({
      db: db as unknown as Database,
      search: makeSearch(bm25),
      dbSearch: {
        searchByVector: vi.fn().mockResolvedValue([{ id: 'c', similarity: 0.9 }]),
        facetsForIds,
      } as unknown as SearchAdapter,
    })

    const result = await hybridSearch(d, { q: 'q-facet-merge', facets: true, limit: 20 })

    expect(facetsForIds).toHaveBeenCalledWith(['c'])
    expect(result.facets?.organizations).toEqual([
      { name: 'org-a', count: 1 },
      { name: 'org-c', count: 1 },
    ])
  })

  it('skips the facet fetch when facets are not requested', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ id: 'c', name: 'pkg-c', title: null, notes: null, organization: null }])
    const facetsForIds = vi.fn()
    const d = deps({
      db: db as unknown as Database,
      search: makeSearch(bm25Result(['a'], 1)),
      dbSearch: {
        searchByVector: vi.fn().mockResolvedValue([{ id: 'c', similarity: 0.9 }]),
        facetsForIds,
      } as unknown as SearchAdapter,
    })

    await hybridSearch(d, { q: 'q-no-facets', limit: 20 })

    expect(facetsForIds).not.toHaveBeenCalled()
  })

  it('passes the notch offset from settings to the vector leg', async () => {
    const d = deps({
      search: makeSearch(bm25Result(['a'])),
      dbSearch: makeDbSearch([{ id: 'a', similarity: 0.9 }]),
      settings: makeSettings({ notches: -2 }),
    })

    await hybridSearch(d, { q: 'q-notch-offset' })

    expect(d.dbSearch.searchByVector).toHaveBeenCalledWith(
      [1, 0, 0],
      'test-model@3',
      expect.anything(),
      50,
      -2 * 0.025
    )
  })

  it('passes no offset when notches is 0 or settings are absent', async () => {
    for (const over of [{ settings: makeSettings() }, {}]) {
      const d = deps({
        search: makeSearch(bm25Result(['a'])),
        dbSearch: makeDbSearch([{ id: 'a', similarity: 0.9 }]),
        ...over,
      })

      await hybridSearch(d, { q: 'q-notch-zero' })

      expect(d.dbSearch.searchByVector).toHaveBeenCalledWith(
        [1, 0, 0],
        'test-model@3',
        expect.anything(),
        50,
        undefined
      )
    }
  })

  it('degrades to keyword-only when semantic search is disabled at runtime', async () => {
    const d = deps({
      search: makeSearch(bm25Result(['a', 'b'])),
      dbSearch: makeDbSearch([{ id: 'c', similarity: 0.9 }]),
      settings: makeSettings({ semanticEnabled: false }),
    })

    const result = await hybridSearch(d, { q: 'q-kill-switch' })

    expect(result.items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(d.dbSearch.searchByVector).not.toHaveBeenCalled()
    // The query embedding (and its provider cost) is skipped entirely
    expect(d.ai.embed).not.toHaveBeenCalled()
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
