/**
 * Minimal non-blocking counting semaphore (ADR-032 Part B).
 *
 * Bounds the number of concurrent in-process DuckDB queries so total memory
 * (per-query materialized table + working memory) stays within the web container.
 * Acquisition is non-blocking: when full, callers get `false` and should reject
 * with 429 rather than queue unboundedly.
 */
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
