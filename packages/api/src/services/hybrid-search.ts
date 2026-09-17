/**
 * Hybrid (BM25 + vector) search service — ADR-034.
 * Fuses keyword results from the configured search backend with pgvector
 * similarity results via Reciprocal Rank Fusion, entirely in this layer so the
 * logic is identical across OpenSearch and PostgreSQL deployments.
 */

import { inArray, eq } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { packageTable, organization, resource } from '@kukan/db'
import type {
  SearchAdapter,
  SearchQuery,
  SearchResult,
  SearchFacets,
  SearchFacetBucket,
  DatasetDoc,
  VectorHit,
  MatchedResource,
} from '@kukan/search-adapter'
import { MAX_MATCHED_RESOURCES_PER_PACKAGE } from '@kukan/search-adapter'
import { resourceDocColumns } from './resource-service'
import { type AIAdapter, embeddingKey } from '@kukan/ai-adapter'
import { createCache, type Logger } from '@kukan/shared'
import {
  FUSION_WINDOW,
  VECTOR_VOTE_RAMP,
  RRF_K,
  VECTOR_LEG_WEIGHT,
  QUERY_EMBED_TIMEOUT_MS,
  QUERY_EMBED_CACHE_MAX,
  QUERY_EMBED_CACHE_TTL_MS,
  VECTOR_SIMILARITY_STEP,
} from '../config'
import {
  VECTOR_SIMILARITY_NOTCHES_KEY,
  SEMANTIC_SEARCH_ENABLED_KEY,
  type SystemSettingService,
} from './system-setting'

export interface HybridSearchDeps {
  db: Database
  /** BM25 backend (OpenSearch, or PostgreSQL fallback) */
  search: SearchAdapter
  /** PostgreSQL adapter — always carries the vectors (ADR-034 Option P) */
  dbSearch: SearchAdapter
  ai: AIAdapter
  logger: Logger
  /** Runtime similarity-floor adjustment (ADR-036); absent means no adjustment */
  settings?: SystemSettingService
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

/** The resources the vector leg named, as the card shows a matched resource */
async function fetchNamedResources(
  db: Database,
  ids: string[]
): Promise<Map<string, MatchedResource>> {
  // The search document's own columns, so a hidden abstract is null here by
  // the same projection the page and the index read (ADR-053)
  const rows = await db.select(resourceDocColumns).from(resource).where(inArray(resource.id, ids))

  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        name: row.name ?? undefined,
        description: row.description ?? undefined,
        format: row.format ?? undefined,
        section: row.section ?? undefined,
        summary: row.summary ?? undefined,
        matchSource: 'semantic' as const,
      } satisfies MatchedResource,
    ])
  )
}

/**
 * Put the resource the vector leg matched among the ones the keyword leg did.
 *
 * **Neither leg orders the list alone** (ADR-054 decision 6). Kept in
 * `inner_hits` order the keyword leg decides; put first, the vector leg does.
 * So the same fusion as the packages': the keyword leg's order is one ranked
 * list, the vector's single resource the other, its vote weighed by how far it
 * cleared the floor — a resource barely above it lands last, not first.
 *
 * A resource both legs found keeps its keyword evidence (the highlight says
 * more than a label can) and only moves up.
 */
export function withSemanticResource(
  doc: DatasetDoc,
  named: MatchedResource,
  weight: number
): DatasetDoc {
  const existing = doc.matchedResources ?? []
  const already = existing.some((r) => r.id === named.id)
  // The keyword entry wins a collision: its highlight says more than a label
  const byId = new Map<string, MatchedResource>([
    [named.id, named],
    ...existing.map((r) => [r.id, r] as const),
  ])
  const matchedResources = fuseRrf(
    existing.map((r) => r.id),
    [{ id: named.id, weight }]
  )
    .map((id) => byId.get(id)!)
    // The adapter's cap holds for the merged list too
    .slice(0, MAX_MATCHED_RESOURCES_PER_PACKAGE)
  // One more resource stands for the hits, unless it was already among them.
  // The carried list is capped, so when the adapter counted more than it
  // carried — or could only give a floor — the resource may be one of the
  // uncounted-here ones already in `total`: then the count stays and becomes a
  // floor rather than being raised on a guess.
  const count = doc.matchedResourcesCount
  const matchedResourcesCount = already
    ? count
    : !count
      ? { total: existing.length + 1, atLeast: false }
      : count.atLeast || count.total > existing.length
        ? { total: count.total, atLeast: true }
        : { total: count.total + 1, atLeast: false }
  return { ...doc, matchedResources, matchedResourcesCount }
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
/**
 * Whether the vector leg ran, and if not, why.
 *
 * Reported rather than inferred. A caller comparing the two legs' results
 * cannot tell a leg that ran and found nothing above the floor from one that
 * never ran: a short query like "お年寄り" clears the floor on nothing at all,
 * and a failed query embedding returns the same empty list (ADR-053 §8.1).
 *
 * `degraded` is the one that matters. The search still answers — keyword
 * results beat an error — but an evaluation run reporting those numbers as
 * hybrid is measuring something it did not do.
 */
export type SemanticState = 'applied' | 'off' | 'degraded'

/** An adapter's result, plus what this layer did with it */
export interface HybridSearchResult extends SearchResult {
  semantic: SemanticState
}

/** A vector hit as the fusion sees it: its rank is its position, its weight
 *  how much of a vote that rank is worth (0–1). BM25 votes always weigh 1. */
export interface WeightedId {
  id: string
  weight: number
}

/**
 * Vote weight for a vector hit: its margin above the floor, over the ramp.
 * At the floor it is nothing; at floor + VECTOR_VOTE_RAMP and beyond, a full
 * vote. See VECTOR_VOTE_RAMP for why the vote is scaled at all.
 */
export function vectorVoteWeight(similarity: number, floor: number): number {
  return Math.min(1, Math.max(0, (similarity - floor) / VECTOR_VOTE_RAMP))
}

export function fuseRrf(bm25Ids: string[], vectorHits: WeightedId[]): string[] {
  const scores = new Map<string, number>()
  bm25Ids.forEach((id, index) => {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1))
  })
  vectorHits.forEach(({ id, weight }, index) => {
    // Scaled by VECTOR_LEG_WEIGHT, which is what decides whether the vector
    // leg can carry an answer keyword search never found
    scores.set(id, (scores.get(id) ?? 0) + (VECTOR_LEG_WEIGHT * weight) / (RRF_K + index + 1))
  })
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
): Promise<HybridSearchResult> {
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
    return { ...(await search.search(searchQuery)), semantic: 'off' }
  }

  // Admin runtime settings (ADR-036) — read after the cheap synchronous
  // degrades. The kill switch also skips the query embedding and its cost.
  let similarityOffset: number | undefined
  if (deps.settings) {
    const [semanticEnabled, notches] = await Promise.all([
      deps.settings.getSetting(SEMANTIC_SEARCH_ENABLED_KEY),
      deps.settings.getSetting(VECTOR_SIMILARITY_NOTCHES_KEY),
    ])
    if (!semanticEnabled) {
      return { ...(await search.search(searchQuery)), semantic: 'off' }
    }
    similarityOffset = notches * VECTOR_SIMILARITY_STEP || undefined
  }

  // Also namespaces the query-embedding cache — a dimension change must not
  // serve vectors cached under the old dimension.
  const key = embeddingKey(info)
  const bm25Promise = search.search({ ...searchQuery, offset: 0, limit: FUSION_WINDOW })
  // The state travels with the hits: an empty list is what a leg that ran and
  // cleared nothing looks like, and also what a failed one looks like.
  const vectorPromise: Promise<{ hits: VectorHit[]; state: SemanticState }> = (async () => {
    const vector = await embedQuery(ai, key, q, logger)
    if (!vector) return { hits: [], state: 'degraded' }
    try {
      const hits = await searchByVector(
        vector,
        key,
        query.filters ?? {},
        FUSION_WINDOW,
        similarityOffset
      )
      return { hits, state: 'applied' }
    } catch (err) {
      logger.error({ err }, 'Vector search failed — degrading to keyword-only search')
      return { hits: [], state: 'degraded' }
    }
  })()
  const [bm25, vector] = await Promise.all([bm25Promise, vectorPromise])
  const vectorHits = vector.hits

  const bm25ById = new Map(bm25.items.map((item) => [item.id, item]))
  const hitById = new Map(vectorHits.map((hit) => [hit.id, hit]))
  // An adapter that cannot say where its floor is gets the old full vote
  const floor = dbSearch.vectorFloor?.(similarityOffset)
  const voteWeight = (similarity: number) =>
    floor === undefined ? 1 : vectorVoteWeight(similarity, floor)
  const fusedIds = fuseRrf(
    bm25.items.map((item) => item.id),
    vectorHits.map((hit) => ({ id: hit.id, weight: voteWeight(hit.similarity) }))
  )
  const windowSemanticIds = fusedIds.filter((id) => !bm25ById.has(id))

  // A page past the fused list but within the keyword total must keep paging in
  // keyword order — reporting total=max(bm25, fused) on earlier pages and then
  // shrinking it here would strand the pagination on an empty page.
  if (offset >= fusedIds.length && bm25.total > offset) {
    return { ...(await search.search(searchQuery)), semantic: vector.state }
  }

  // Enrich only the requested page — semantic docs outside it would be discarded
  const pageIds = fusedIds.slice(offset, offset + limit)
  const pageSemanticIds = pageIds.filter((id) => !bm25ById.has(id))
  // The resource each vector hit on this page is about (ADR-054): for a
  // semantic-only package it is the whole explanation of why it is here, and
  // for a keyword package it is one more resource worth naming — unless the
  // keyword leg already carries it, in which case there is only reordering to do
  const namedResourceIds = pageIds.flatMap((id) => {
    const resourceId = hitById.get(id)?.resourceId
    if (!resourceId) return []
    const carried = bm25ById.get(id)?.matchedResources?.some((r) => r.id === resourceId)
    return carried ? [] : [resourceId]
  })

  const [semanticDocs, namedResources, vectorFacets] = await Promise.all([
    pageSemanticIds.length > 0
      ? fetchSemanticDocs(db, pageSemanticIds)
      : new Map<string, DatasetDoc>(),
    namedResourceIds.length > 0
      ? fetchNamedResources(db, namedResourceIds)
      : new Map<string, MatchedResource>(),
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
    .map((id) => {
      const doc = bm25ById.get(id) ?? semanticDocs.get(id)
      const hit = hitById.get(id)
      const named = hit
        ? (namedResources.get(hit.resourceId) ??
          doc?.matchedResources?.find((r) => r.id === hit.resourceId))
        : undefined
      if (!doc || !hit || !named) return doc
      return withSemanticResource(
        doc,
        { ...named, similarity: hit.similarity },
        voteWeight(hit.similarity)
      )
    })
    // A package can vanish between the vector query and the doc fetch
    .filter((doc): doc is DatasetDoc => doc !== undefined)

  return {
    items,
    // Semantic-only hits can push the fused count past the BM25 total
    total: Math.max(bm25.total, fusedIds.length),
    offset,
    limit,
    facets,
    semantic: vector.state,
  }
}
