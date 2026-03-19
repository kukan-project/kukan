/**
 * KUKAN Adapter Type Definitions
 * Shared types for Storage, Search, Queue, and AI adapters
 */

// ============================================================
// Storage Adapter Types
// ============================================================

export interface ObjectMeta {
  contentType?: string
  contentLength?: number
  originalFilename?: string
  [key: string]: unknown
}

export type IngestStatus = 'pending' | 'queued' | 'processing' | 'complete' | 'error'

// ============================================================
// Search Adapter Types
// ============================================================

/** Maximum matched resources returned per package across all search adapters */
export const MAX_MATCHED_RESOURCES_PER_PACKAGE = 1000

export interface MatchedResource {
  id: string
  name?: string
  description?: string
  format?: string
}

/**
 * Group flat matched-resource rows by packageId and cap each group.
 * Shared by PostgresSearchAdapter and PackageService to avoid duplication.
 */
export function groupMatchedResources(
  rows: {
    id: string
    packageId: string
    name: string | null
    description: string | null
    format: string | null
  }[]
): Record<string, MatchedResource[]> {
  const byPackage: Record<string, MatchedResource[]> = {}
  for (const row of rows) {
    if (!byPackage[row.packageId]) {
      byPackage[row.packageId] = []
    }
    byPackage[row.packageId].push({
      id: row.id,
      name: row.name ?? undefined,
      description: row.description ?? undefined,
      format: row.format ?? undefined,
    })
  }
  for (const pkgId of Object.keys(byPackage)) {
    if (byPackage[pkgId].length > MAX_MATCHED_RESOURCES_PER_PACKAGE) {
      byPackage[pkgId] = byPackage[pkgId].slice(0, MAX_MATCHED_RESOURCES_PER_PACKAGE)
    }
  }
  return byPackage
}

export interface DatasetDoc {
  id: string
  name: string
  title?: string
  notes?: string
  tags?: string[]
  organization?: string
  matchedResources?: MatchedResource[]
  [key: string]: unknown
}

export interface SearchQuery {
  q: string
  offset?: number
  limit?: number
  filters?: Record<string, unknown>
}

export interface SearchResult {
  items: DatasetDoc[]
  total: number
  offset: number
  limit: number
}

// ============================================================
// Queue Adapter Types
// ============================================================

export interface Job<T = unknown> {
  id: string
  type: string
  data: T
}

export type JobState = 'pending' | 'processing' | 'completed' | 'failed'

export interface JobStatus {
  id: string
  status: JobState
  error?: string
}

// ============================================================
// AI Adapter Types
// ============================================================

export interface ResourceMeta {
  id: string
  name?: string
  format?: string
  url?: string
  description?: string
  [key: string]: unknown
}
