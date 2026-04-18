/**
 * KUKAN Search Adapter Interface
 * Pluggable search backend (OpenSearch or PostgreSQL)
 */

// ============================================================
// Search Types
// ============================================================

export interface MatchedResource {
  id: string
  name?: string
  description?: string
  format?: string
  /** Highlighted snippet from content match */
  contentSnippet?: string
  /** Whether the match came from resource metadata or extracted content */
  matchSource?: 'metadata' | 'content'
}

/** Document stored in the kukan-resources index */
export interface ResourceDoc {
  /** Resource UUID (used as OpenSearch document ID) */
  id: string
  /** Parent package UUID */
  packageId: string
  name?: string
  description?: string
  format?: string
  /** Extracted text content for full-text search (up to 100KB) */
  extractedText?: string
  /** Content type: 'tabular' | 'text' | 'manifest' | null */
  contentType?: string
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
  /**
   * Index a dataset document (kukan-packages)
   */
  index(doc: DatasetDoc): Promise<void>

  /**
   * Search for datasets (kukan-packages + kukan-resources via msearch)
   */
  search(query: SearchQuery): Promise<SearchResult>

  /**
   * Delete a dataset from the index (kukan-packages)
   */
  delete(id: string): Promise<void>

  /**
   * Bulk index multiple dataset documents (kukan-packages)
   */
  bulkIndex(docs: DatasetDoc[]): Promise<void>

  /**
   * Delete all dataset documents from the index (kukan-packages, for full rebuild)
   */
  deleteAll(): Promise<void>

  /**
   * Sum total active resource count across packages matching the given query/filters.
   * Uses the same visibility / filter logic as search().
   */
  sumResourceCount(query?: ResourceCountQuery): Promise<number>

  // ---- Resource-level index (kukan-resources) ----

  /**
   * Index a resource document (metadata + optional extracted content).
   * Upsert semantics: creates or replaces the document.
   */
  indexResource(doc: ResourceDoc): Promise<void>

  /**
   * Bulk index multiple resource documents
   */
  bulkIndexResources(docs: ResourceDoc[]): Promise<void>

  /**
   * Delete a resource from the resource index
   */
  deleteResource(resourceId: string): Promise<void>

  /**
   * Delete all resource documents (for full rebuild)
   */
  deleteAllResources(): Promise<void>
}
