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
  [key: string]: unknown
}

// ============================================================
// Search Adapter Types
// ============================================================

export interface DatasetDoc {
  id: string
  name: string
  title?: string
  notes?: string
  tags?: string[]
  organization?: string
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
