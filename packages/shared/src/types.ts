/**
 * KUKAN Common Type Definitions
 */

/**
 * Pagination parameters for list queries
 */
export interface PaginationParams {
  offset?: number
  limit?: number
}

/**
 * Paginated result wrapper
 */
export interface PaginatedResult<T> {
  items: T[]
  total: number
  offset: number
  limit: number
}

/**
 * Facet count item for filter sidebar
 */
export interface FacetItem {
  name: string
  title?: string | null
  count: number
}

/**
 * Facet counts for dataset list filtering
 */
export interface FacetCounts {
  organizations: FacetItem[]
  groups: FacetItem[]
  tags: FacetItem[]
  formats: FacetItem[]
}

/**
 * RFC 7807 Problem Details for HTTP APIs
 * @see https://datatracker.ietf.org/doc/html/rfc7807
 */
export interface ProblemDetail {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
}
