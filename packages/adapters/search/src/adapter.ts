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
}

export interface SearchQuery {
  q: string
  offset?: number
  limit?: number
  filters?: SearchFilters
  /** Request aggregation-based facet counts */
  facets?: boolean
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
   * Index a dataset document
   */
  index(doc: DatasetDoc): Promise<void>

  /**
   * Search for datasets
   */
  search(query: SearchQuery): Promise<SearchResult>

  /**
   * Delete a dataset from the index
   */
  delete(id: string): Promise<void>

  /**
   * Bulk index multiple documents
   */
  bulkIndex(docs: DatasetDoc[]): Promise<void>

  /**
   * Delete all documents from the index (for full rebuild)
   */
  deleteAll(): Promise<void>
}
