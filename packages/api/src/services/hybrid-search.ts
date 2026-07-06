/**
 * Hybrid (BM25 + vector) search service — ADR-034.
 * Fuses keyword results from the configured search backend with pgvector
 * similarity results via Reciprocal Rank Fusion, entirely in this layer so the
 * logic is identical across OpenSearch and PostgreSQL deployments.
 */

import { inArray, eq } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { packageTable, organization } from '@kukan/db'
import type {
  SearchAdapter,
  SearchQuery,
  SearchResult,
  SearchFacets,
  SearchFacetBucket,
  DatasetDoc,
  VectorHit,
} from '@kukan/search-adapter'
import { type AIAdapter, embeddingKey } from '@kukan/ai-adapter'
import { createCache, type Logger } from '@kukan/shared'
import {
  FUSION_WINDOW,
  RRF_K,
  QUERY_EMBED_TIMEOUT_MS,
  QUERY_EMBED_CACHE_MAX,
  QUERY_EMBED_CACHE_TTL_MS,
} from '../config'

export interface HybridSearchDeps {
  db: Database
  /** BM25 backend (OpenSearch, or PostgreSQL fallback) */
  search: SearchAdapter
  /** PostgreSQL adapter — always carries the vectors (ADR-034 Option P) */
  dbSearch: SearchAdapter
  ai: AIAdapter
  logger: Logger
}

export type HybridSearchQuery = SearchQuery & {
  /** false disables the vector leg for this request (default true) */
  semantic?: boolean
}

/** Query embeddings are tiny and hot (every search reuses them) — cache per process */
const queryEmbedCache = createCache({
  max: QUERY_EMBED_CACHE_MAX,
  ttlMs: QUERY_EMBED_CACHE_TTL_MS,
})

/** Embed the query text, bounded by a short timeout. Returns null on any
 *  failure so the caller degrades to keyword-only search. */
async function embedQuery(
  ai: AIAdapter,
  modelKey: string,
  text: string,
  logger: Logger
): Promise<number[] | null> {
  const key = `${modelKey}:${text}`
  const cached = queryEmbedCache.get(key) as number[] | undefined
  if (cached) return cached

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const vector = await Promise.race([
      ai.embed(text, { type: 'query' }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`query embedding timed out (${QUERY_EMBED_TIMEOUT_MS}ms)`)),
          QUERY_EMBED_TIMEOUT_MS
        )
      }),
    ])
    queryEmbedCache.set(key, vector)
    return vector
  } catch (err) {
    logger.warn({ err }, 'Query embedding failed — degrading to keyword-only search')
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Fetch minimal DatasetDocs for vector-only hits (BM25 knows nothing about
 *  them, and MCP renders search items without further enrichment). */
async function fetchSemanticDocs(db: Database, ids: string[]): Promise<Map<string, DatasetDoc>> {
  const rows = await db
    .select({
      id: packageTable.id,
      name: packageTable.name,
      title: packageTable.title,
      notes: packageTable.notes,
      organization: organization.name,
    })
    .from(packageTable)
    .leftJoin(organization, eq(packageTable.ownerOrg, organization.id))
    .where(inArray(packageTable.id, ids))

  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        name: row.name,
        title: row.title ?? undefined,
        notes: row.notes ?? undefined,
        organization: row.organization ?? undefined,
        matchSource: 'semantic' as const,
      } satisfies DatasetDoc,
    ])
  )
}

/** Sum facet buckets by name so counts cover BM25 matches + vector-only hits */
export function mergeFacets(base: SearchFacets | undefined, add: SearchFacets): SearchFacets {
  if (!base) return add
  const mergeBuckets = (a: SearchFacetBucket[], b: SearchFacetBucket[]): SearchFacetBucket[] => {
    const counts = new Map(a.map((bucket) => [bucket.name, bucket.count]))
    for (const bucket of b) counts.set(bucket.name, (counts.get(bucket.name) ?? 0) + bucket.count)
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((x, y) => y.count - x.count)
  }
  return {
    organizations: mergeBuckets(base.organizations, add.organizations),
    groups: mergeBuckets(base.groups, add.groups),
    tags: mergeBuckets(base.tags, add.tags),
    formats: mergeBuckets(base.formats, add.formats),
    licenses: mergeBuckets(base.licenses, add.licenses),
  }
}

/** score(doc) = Σ over result lists of 1 / (RRF_K + rank), rank starting at 1 */
export function fuseRrf(bm25Ids: string[], vectorIds: string[]): string[] {
  const scores = new Map<string, number>()
  for (const ids of [bm25Ids, vectorIds]) {
    ids.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1))
    })
  }
  // Stable order for equal scores: BM25 rank, then vector rank
  return [...scores.keys()].sort((a, b) => scores.get(b)! - scores.get(a)!)
}

/**
 * Search datasets, fusing BM25 and vector similarity when possible.
 * Falls back to plain keyword search when any of these hold:
 * - semantic=false, empty query, or an explicit sort (relevance-only feature)
 * - no embedding capability (NoOp) or no vector support on the DB adapter
 * - the requested page starts beyond the fused list (keyword-order paging)
 * - query embedding or vector search fails (never fails the request)
 */
export async function hybridSearch(
  deps: HybridSearchDeps,
  query: HybridSearchQuery
): Promise<SearchResult> {
  const { db, search, dbSearch, ai, logger } = deps
  const { semantic, ...searchQuery } = query
  const q = query.q.trim()
  const offset = query.offset ?? 0
  const limit = query.limit ?? 20
  const info = ai.getEmbeddingInfo()
  const searchByVector = dbSearch.searchByVector?.bind(dbSearch)

  if (
    semantic === false ||
    q.length === 0 ||
    query.sortBy !== undefined ||
    info === null ||
    searchByVector === undefined ||
    // The fused list holds at most FUSION_WINDOW ids per leg
    offset >= FUSION_WINDOW * 2
  ) {
    return search.search(searchQuery)
  }

  // Also namespaces the query-embedding cache — a dimension change must not
  // serve vectors cached under the old dimension.
  const key = embeddingKey(info)
  const bm25Promise = search.search({ ...searchQuery, offset: 0, limit: FUSION_WINDOW })
  const vectorPromise: Promise<VectorHit[]> = (async () => {
    const vector = await embedQuery(ai, key, q, logger)
    if (!vector) return []
    try {
      return await searchByVector(vector, key, query.filters ?? {}, FUSION_WINDOW)
    } catch (err) {
      logger.error({ err }, 'Vector search failed — degrading to keyword-only search')
      return []
    }
  })()
  const [bm25, vectorHits] = await Promise.all([bm25Promise, vectorPromise])

  const bm25ById = new Map(bm25.items.map((item) => [item.id, item]))
  const fusedIds = fuseRrf(
    bm25.items.map((item) => item.id),
    vectorHits.map((hit) => hit.id)
  )
  const windowSemanticIds = fusedIds.filter((id) => !bm25ById.has(id))

  // A page past the fused list but within the keyword total must keep paging in
  // keyword order — reporting total=max(bm25, fused) on earlier pages and then
  // shrinking it here would strand the pagination on an empty page.
  if (offset >= fusedIds.length && bm25.total > offset) {
    return search.search(searchQuery)
  }

  // Enrich only the requested page — semantic docs outside it would be discarded
  const pageIds = fusedIds.slice(offset, offset + limit)
  const pageSemanticIds = pageIds.filter((id) => !bm25ById.has(id))

  const [semanticDocs, vectorFacets] = await Promise.all([
    pageSemanticIds.length > 0
      ? fetchSemanticDocs(db, pageSemanticIds)
      : new Map<string, DatasetDoc>(),
    // Facet counts from the BM25 leg alone would contradict the visible list
    // (zero everywhere when only vector hits exist) — count the vector-only
    // window hits too. The vector leg already applied the same visibility
    // filters. Window-limited, the same asymmetry as `total`.
    query.facets && windowSemanticIds.length > 0 && dbSearch.facetsForIds
      ? dbSearch.facetsForIds(windowSemanticIds)
      : undefined,
  ])
  const facets = vectorFacets ? mergeFacets(bm25.facets, vectorFacets) : bm25.facets

  const items = pageIds
    .map((id) => bm25ById.get(id) ?? semanticDocs.get(id))
    // A package can vanish between the vector query and the doc fetch
    .filter((doc): doc is DatasetDoc => doc !== undefined)

  return {
    items,
    // Semantic-only hits can push the fused count past the BM25 total
    total: Math.max(bm25.total, fusedIds.length),
    offset,
    limit,
    facets,
  }
}
