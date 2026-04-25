/**
 * KUKAN Search Adapter Interface
 * Pluggable search backend (OpenSearch or PostgreSQL)
 */

import type { ContentType } from '@kukan/shared'

// ============================================================
// Search Types
// ============================================================

export interface MatchedResource {
  id: string
  name?: string
  description?: string
  format?: string
  /** Highlighted name (HTML with <mark> tags) */
  highlightedName?: string
  /** Highlighted description (HTML with <mark> tags) */
  highlightedDescription?: string
  /** Highlighted snippets from content match (up to 3 fragments) */
  contentSnippets?: string[]
  /** Whether the match came from resource metadata or extracted content */
  matchSource?: 'metadata' | 'content'
  /** Content chunk document ID for lazy highlight loading (passed to POST /highlights) */
  _contentDocId?: string
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
  private?: boolean
  owner_org_id?: string
  creator_user_id?: string
  created?: Date | string
  updated?: Date | string
  /** Highlighted title (HTML with <mark> tags) — populated by search only */
  highlightedTitle?: string
  /** Highlighted notes (HTML with <mark> tags) — populated by search only */
  highlightedNotes?: string
  [key: string]: unknown
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
   *  Used for lazy-loading snippets after initial search results are displayed. */
  fetchContentHighlights(chunkDocIds: string[], queryText: string): Promise<Record<string, string>>
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
  sizeBytes: number
  /** Most recently indexed documents (up to 5) */
  recentDocs: Array<{ id: string; name?: string; updated?: string }>
}

export interface IndexStats {
  packages: IndexStatsEntry
  resources: IndexStatsEntry
  contents: IndexStatsEntry
}
