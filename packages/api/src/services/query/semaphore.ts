/**
 * Minimal non-blocking counting semaphore (ADR-032 Part B).
 *
 * Bounds the number of concurrent in-process DuckDB queries so total memory
 * (per-query materialized table + working memory) stays within the web container.
 * Acquisition is non-blocking: when full, callers get `false` and should reject
 * with 429 rather than queue unboundedly.
 */
import { TooManyRequestsError } from '@kukan/shared'
import { QUERY_MAX_CONCURRENT } from '../../config'

export class Semaphore {
  private active = 0

  constructor(private readonly max: number) {}

  /** Reserve a slot. Returns false when at capacity (no slot taken). */
  tryAcquire(): boolean {
    if (this.active >= this.max) return false
    this.active++
    return true
  }

  /** Release a previously acquired slot. */
  release(): void {
    if (this.active > 0) this.active--
  }

  /** Currently held slots (for tests / observability). */
  get inUse(): number {
    return this.active
  }
}

/**
 * Shared by every in-process DuckDB user — ADR-032 resource queries and ADR-043
 * version diffs alike. They run in the same container and draw on the same
 * memory, so one budget covers both; two independent semaphores would each
 * think they had the whole container.
 */
const duckdbSemaphore = new Semaphore(QUERY_MAX_CONCURRENT)

/**
 * Run `fn` holding a DuckDB slot, or reject with 429. The release sits in a
 * `finally` around everything the caller does — including opening the session —
 * because with a cap of one, a single leaked slot wedges every later query.
 */
export async function withDuckdbSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (!duckdbSemaphore.tryAcquire()) {
    throw new TooManyRequestsError('Too many concurrent queries; please retry shortly')
  }
  try {
    return await fn()
  } finally {
    duckdbSemaphore.release()
  }
}
