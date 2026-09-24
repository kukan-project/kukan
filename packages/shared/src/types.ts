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
 * Package lifecycle states exposed by the API (ADR-039). The transient
 * `purging` claim state is deliberately excluded.
 */
export const PACKAGE_STATES = ['draft', 'active', 'deleted'] as const

export type PackageState = (typeof PACKAGE_STATES)[number]

/** Every state a package row can hold in the DB, including the transient GC claim. */
export type PackageDbState = PackageState | 'purging'

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
  licenses: FacetItem[]
}

/**
 * Whether a search's vector leg ran, and if not, why (ADR-034).
 *
 * Reported rather than inferred: a leg that ran and cleared nothing above the
 * floor returns the same empty list as one whose query embedding failed. So
 * `degraded` — keyword results answering for a hybrid search that never
 * happened — is knowable only because the search says so (ADR-053 §8.1).
 */
export type SemanticState = 'applied' | 'off' | 'degraded'

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
  details?: Record<string, unknown>
}
