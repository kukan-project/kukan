/**
 * KUKAN Search Adapter Interface
 * Pluggable search backend (OpenSearch or PostgreSQL)
 */

import type { ContentType } from '@kukan/shared'

// ============================================================
// Search Types
// ============================================================

/** The resource metadata fields a query term can match, as the adapters report them.
 *  Shared, so the two adapters cannot disagree about what is searchable — the
 *  abstract is in the keyword leg on both (ADR-053 §8.1). */
export const MATCHED_FIELDS = ['name', 'description', 'section', 'summary'] as const
export type MatchedField = (typeof MATCHED_FIELDS)[number]

export interface MatchedResource {
  id: string
  name?: string
  description?: string
  format?: string
  /** The section the resource is drawn under (ADR-050) */
  section?: string
  /** The AI-written abstract (ADR-053). Whole — the PostgreSQL leg cannot
   *  fragment, and the card clamps it */
  summary?: string
  /** The metadata fields the query matched — what the hit is on account of */
  matchedOn?: MatchedField[]
  /** Highlighted name (HTML with <mark> tags) */
  highlightedName?: string
  /** Highlighted description (HTML with <mark> tags) */
  highlightedDescription?: string
  /** Highlighted section (HTML with <mark> tags) */
  highlightedSection?: string
  /** The abstract around the match, marked (HTML with <mark> tags) */
  highlightedSummary?: string
  /** Highlighted snippets from content match (up to 3 fragments) */
  contentSnippets?: string[]
  /** What the match is on account of: the resource's metadata, its extracted
   *  content, or — with no word to point at — its meaning (ADR-054) */
  matchSource?: 'metadata' | 'content' | 'semantic'
  /** Cosine similarity the vector leg matched at — on a 'semantic' entry only.
   *  What the floor is measured against, so it travels with the hit */
  similarity?: number
  /** Content chunk document ID for lazy highlight loading (passed to POST /highlights) */
  _contentDocId?: string
}

export interface MatchedResourcesCount {
  total: number
  atLeast: boolean
}

/** Document stored in the kukan-resources index (metadata only) */
export interface ResourceDoc {
  /** Resource UUID (used as OpenSearch document ID) */
  id: string
  /** Parent package UUID */
  packageId: string
  name?: string
  description?: string
  format?: string
  /** The section the resource is drawn under (ADR-050) */
  section?: string
  /** The AI-written abstract, absent when hidden or never written (ADR-053) */
  summary?: string
}

/** Document stored in the kukan-contents index (extracted text for full-text search) */
export interface ContentDoc {
  /** Resource UUID */
  resourceId: string
  /** Parent package UUID */
  packageId: string
  /** Extracted text content (one chunk) */
  extractedText: string
  /** Content type for indexed text */
  contentType: ContentType
  /** Zero-based chunk index */
  chunkIndex: number
  /** Size of this chunk in bytes */
  chunkSize?: number
}

/** Maximum matched resources returned per package across all search adapters.
 *  Also used as OpenSearch inner_hits size (must be <= index.max_inner_result_window, default 100). */
export const MAX_MATCHED_RESOURCES_PER_PACKAGE = 100

export interface DatasetDoc {
  id: string
  name: string
  title?: string
  notes?: string
  tags?: string[]
  organization?: string
  license_id?: string
  groups?: string[]
  formats?: string[]
  matchedResources?: MatchedResource[]
  /** How many resources matched in all — `atLeast` when the adapter could not
   *  settle it: it carried fewer than matched, or content hits past its cap are
   *  chunks whose resources cannot be told */
  matchedResourcesCount?: MatchedResourcesCount
  private?: boolean
  owner_org_id?: string
  creator_user_id?: string
  created?: Date | string
  updated?: Date | string
  /** Highlighted title (HTML with <mark> tags) — populated by search only */
  highlightedTitle?: string
  /** Highlighted notes (HTML with <mark> tags) — populated by search only */
  highlightedNotes?: string
  /** 'semantic' when the hit came from vector search only (no keyword match) */
  matchSource?: 'semantic'
  [key: string]: unknown
}

/** A vector-search hit (pgvector cosine similarity, ADR-034 / ADR-054) */
export interface VectorHit {
  /** Package UUID — the unit a result is returned in */
  id: string
  /** The resource whose vector this is: the package's closest one, which is
   *  what puts the package where it is and the table the reader is sent to */
  resourceId: string
  /** Cosine similarity in [−1, 1] (1 = identical direction) */
  similarity: number
}

export interface SearchFilters {
  // Content filters
  name?: string
  organizations?: string[]
  tags?: string[]
  formats?: string[]
  licenses?: string[]
  groups?: string[]
  // Visibility + access filters
  excludePrivate?: boolean
  allowPrivateOrgIds?: string[]
  ownerOrgIds?: string[]
  creatorUserId?: string
  isPrivate?: boolean
  // State filter (default: 'active')
  state?: 'active' | 'deleted'
}

export interface SearchQuery {
  q: string
  offset?: number
  limit?: number
  filters?: SearchFilters
  /** Request aggregation-based facet counts */
  facets?: boolean
  /** Sort field. When omitted, adapters use their default
   *  (OpenSearch: _score+updated for queries, updated for browse;
   *   PostgreSQL: updated DESC). */
  sortBy?: 'updated' | 'created' | 'name'
  /** Sort direction (default: desc) */
  sortOrder?: 'asc' | 'desc'
}

/** Query parameters for resource count aggregation (no pagination needed) */
export interface ResourceCountQuery {
  q?: string
  filters?: SearchFilters
}

export interface SearchFacetBucket {
  name: string
  count: number
}

export interface SearchFacets {
  organizations: SearchFacetBucket[]
  groups: SearchFacetBucket[]
  tags: SearchFacetBucket[]
  formats: SearchFacetBucket[]
  licenses: SearchFacetBucket[]
}

export interface SearchResult {
  items: DatasetDoc[]
  total: number
  offset: number
  limit: number
  facets?: SearchFacets
}

// ============================================================
// Adapter Interface
// ============================================================

export interface SearchAdapter {
  // ---- Dataset-level index (kukan-packages) ----

  /** Index a dataset document */
  indexPackage(doc: DatasetDoc): Promise<void>

  /** Delete a dataset from the index */
  deletePackage(id: string): Promise<void>

  /** Bulk index multiple dataset documents */
  bulkIndexPackages(docs: DatasetDoc[]): Promise<void>

  /** Delete all dataset documents (for full rebuild) */
  deleteAllPackages(): Promise<void>

  // ---- Resource-level index (kukan-resources) ----

  /** Index a resource document (metadata only). Upsert semantics. */
  indexResource(doc: ResourceDoc): Promise<void>

  /** Delete a resource from the resource index */
  deleteResource(resourceId: string): Promise<void>

  /** Bulk index multiple resource documents */
  bulkIndexResources(docs: ResourceDoc[]): Promise<void>

  /** Delete all resource documents (for full rebuild) */
  deleteAllResources(): Promise<void>

  // ---- Content-level index (kukan-contents) ----

  /** Index extracted text content for a resource. Upsert semantics. */
  indexContent(doc: ContentDoc): Promise<void>

  /** Delete content for a resource */
  deleteContent(resourceId: string): Promise<void>

  /** Delete all content documents (for full rebuild) */
  deleteAllContents(): Promise<void>

  // ---- Cross-index operations ----

  /** Search for datasets (kukan-packages + kukan-resources + kukan-contents via msearch) */
  search(query: SearchQuery): Promise<SearchResult>

  /** Sum total active resource count across packages matching the given query/filters */
  sumResourceCount(query?: ResourceCountQuery): Promise<number>

  /** Get index statistics (document counts, sizes). Returns null if not supported. */
  getIndexStats(): Promise<IndexStats | null>

  /**
   * Whether the live index was created under an analysis the code no longer
   * defines. Its own call rather than part of `getIndexStats`, because what
   * asks is a dashboard notice that should cost one request, not a page of
   * counts. False on a backend that fixes no analysis at index creation.
   *
   * Throws where the answer cannot be had. A caller that only decorates a
   * screen should read that as "say nothing"; a job that would otherwise
   * acknowledge its message must not read it as "already current".
   */
  analysisStale(): Promise<boolean>

  /**
   * The resources that have content indexed, a page at a time, so a caller can
   * tell which of them the database no longer has. `after` continues from the
   * last id of the previous page. Empty on a backend that indexes no content.
   */
  indexedContentResources(after?: string, limit?: number): Promise<string[]>

  /**
   * Rebuild the index under the analysis the code now defines, keeping the
   * documents: create the next index, copy into it, swap the alias, drop the
   * old one. Null on a backend whose analysis is not fixed at creation — the
   * PostgreSQL fallback re-reads its own columns on every query — the same way
   * `getIndexStats` answers for a backend with no index to describe.
   *
   * **Writes during the copy land on the index being replaced and are lost
   * with it.** The window is the copy, seconds on a small catalogue; a document
   * written inside it is restored by the ordinary metadata rebuild.
   */
  reanalyseIndex(): Promise<{ from: string; to: string; documents: number } | null>

  /**
   * When the copy that produced the live index began, while its repair is
   * unfinished. Null where nothing is pending, or on a backend that copies no
   * index. Recorded on the index rather than in the job, because a queue
   * message may be delivered again to a process that knows nothing of the
   * attempt that swapped.
   */
  pendingRepair(): Promise<Date | null>

  /** Record that the repair of the live index is done */
  markRepaired(): Promise<void>

  /** Get a single document from an index by ID. Returns null if not found or not supported. */
  getDocument(
    index: 'packages' | 'resources' | 'contents',
    id: string
  ): Promise<Record<string, unknown> | null>

  /** Browse/search documents in an index with pagination. Returns null if not supported. */
  browseDocuments(
    index: 'packages' | 'resources' | 'contents',
    options: { q?: string; offset?: number; limit?: number }
  ): Promise<BrowseResult | null>

  /** Get individual content chunks for a resource. Returns empty array if not supported. */
  getContentChunks(
    resourceId: string
  ): Promise<Array<{ id: string; chunkIndex: number; chunkSize: number }>>

  /** Browse contents grouped by resource. Returns null if not supported. */
  browseContentsByResource(options: {
    q?: string
    offset?: number
    limit?: number
  }): Promise<ContentBrowseResult | null>

  /** Fetch content highlights for specific chunk document IDs.
   *  Returns a map of chunkDocId → highlighted snippet.
   *  Used for lazy-loading snippets after initial search results are displayed.
   *  `filters` MUST carry the caller's visibility scope (excludePrivate /
   *  allowPrivateOrgIds) so chunks from private datasets the caller cannot see
   *  are not returned — the chunk IDs are caller-supplied and guessable. */
  fetchContentHighlights(
    chunkDocIds: string[],
    queryText: string,
    filters?: SearchFilters
  ): Promise<Record<string, string>>

  /** Vector similarity search over resource embeddings (pgvector, ADR-034 /
   *  ADR-054). PostgreSQL-only — vectors live in the resource table regardless
   *  of the BM25 backend, so callers use the dbSearch adapter. `modelKey` is the
   *  vector-space key from embeddingKey() (model@dimensions), NOT the bare
   *  model name. `filters` MUST carry the caller's visibility scope. Absent on
   *  backends without vector support. `minSimilarityOffset` shifts the
   *  configured similarity floor per call (admin tuning, ADR-036); the
   *  adjusted floor is clamped to [0, 1]. */
  /**
   * The similarity floor `searchByVector` will apply for this offset — the
   * model's measured floor shifted by the admin's notches (ADR-036).
   *
   * Asked rather than recomputed by the caller, so the two cannot drift: the
   * fusion weighs each vector vote by how far it sits above this line, and a
   * vote weighed against a different line than the one that admitted it is
   * exactly the kind of quiet disagreement that ends up in a bill or a bug.
   * PostgreSQL-only, like searchByVector.
   */
  vectorFloor?(minSimilarityOffset?: number): number

  searchByVector?(
    vector: number[],
    modelKey: string,
    filters: SearchFilters,
    k: number,
    minSimilarityOffset?: number
  ): Promise<VectorHit[]>

  /** Facet counts for an explicit set of package IDs — used to merge vector-only
   *  hits into the BM25 facets (hybrid search). PostgreSQL-only, like searchByVector. */
  facetsForIds?(ids: string[]): Promise<SearchFacets>
}

export interface BrowseResult {
  items: Array<{ id: string; source: Record<string, unknown> }>
  total: number
  offset: number
  limit: number
}

/** Grouped content browse result — one entry per resource */
export interface ContentBrowseItem {
  resourceId: string
  packageId: string
  contentType: string
  chunks: number
  totalSize: number
  resourceName?: string
  resourceFormat?: string
}

export interface ContentBrowseResult {
  items: ContentBrowseItem[]
  total: number
  offset: number
  limit: number
}

export interface IndexStatsEntry {
  docCount: number
  /** Most recently indexed documents (up to 5) */
  recentDocs: Array<{ id: string; name?: string; updated?: string }>
}

export interface IndexStats {
  indexName: string
  totalSizeBytes: number
  packages: IndexStatsEntry
  resources: IndexStatsEntry
  contents: IndexStatsEntry
}
