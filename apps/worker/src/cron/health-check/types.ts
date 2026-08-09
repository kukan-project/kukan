/**
 * Health check type definitions
 */

/** Resource data needed for health check */
export interface ResourceForHealthCheck {
  id: string
  url: string
  hash: string | null
  healthStatus: string | null
  healthCheckedAt: Date | null
  extras: Record<string, unknown>
}

/** Result of a single HEAD request */
export interface HeadCheckResult {
  /** HTTP status code, or null if request failed (timeout, network error) */
  httpStatus: number | null
  /** New health status to store */
  healthStatus: 'ok' | 'error'
  /** ETag response header */
  etag: string | null
  /** Last-Modified response header */
  lastModified: string | null
  /** Whether the resource content appears to have changed */
  changed: boolean
  /** Error message if request failed */
  errorMessage: string | null
  /** The transport reason behind it, for the log rather than the row */
  errorDetail: string | null
}

/** Summary of a batch run */
export interface BatchSummary {
  total: number
  checked: number
  ok: number
  error: number
  changed: number
  enqueuedForFullFetch: number
  /**
   * Selected but never started, because its turn fell outside the batch's
   * budget. The row keeps the `healthCheckedAt` it had, so the next tick reads
   * it first and the batch goes on from where it stopped.
   */
  deferred: number
}
