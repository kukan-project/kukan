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
  DatasetDoc,
  VectorHit,
} from '@kukan/search-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'
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
  model: string,
  text: string,
  logger: Logger
): Promise<number[] | null> {
  const key = `${model}:${text}`
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
 * - the requested page lies beyond the fusion window
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
    offset + limit > FUSION_WINDOW
  ) {
    return search.search(searchQuery)
  }

  const bm25Promise = search.search({ ...searchQuery, offset: 0, limit: FUSION_WINDOW })
  const vectorPromise: Promise<VectorHit[]> = (async () => {
    const vector = await embedQuery(ai, info.model, q, logger)
    if (!vector) return []
    try {
      return await searchByVector(vector, info.model, query.filters ?? {}, FUSION_WINDOW)
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

  // Enrich only the requested page — semantic docs outside it would be discarded
  const pageIds = fusedIds.slice(offset, offset + limit)
  const semanticOnlyIds = pageIds.filter((id) => !bm25ById.has(id))
  const semanticDocs =
    semanticOnlyIds.length > 0
      ? await fetchSemanticDocs(db, semanticOnlyIds)
      : new Map<string, DatasetDoc>()

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
    facets: bm25.facets,
  }
}
