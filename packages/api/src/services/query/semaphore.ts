/**
 * Bounded counting semaphore for in-process DuckDB work (ADR-032 Part B).
 *
 * Bounds the number of concurrent queries so total memory (per-query
 * materialized table + working memory) stays within the web container. Callers
 * queue rather than being refused on contention: with a cap of one, refusing
 * made a 429 out of any two overlapping requests. The queue is bounded in both
 * depth and per-caller wait, so 429 means a backlog rather than a coincidence.
 */
import { RequestAbandonedError, TooManyRequestsError } from '@kukan/shared'
import { QUERY_MAX_CONCURRENT, QUERY_QUEUE_MAX, QUERY_QUEUE_WAIT_MS } from '../../config'

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
  /** Clears this waiter's timer and abort listener. */
  settle: () => void
}

export class Semaphore {
  private active = 0
  private readonly waiters: Waiter[] = []

  constructor(
    private readonly max: number,
    private readonly maxWaiting: number,
    private readonly waitMs: number
  ) {}

  /**
   * Reserve a slot, waiting in FIFO order for one to free up. Rejects with 429
   * when the queue is full or the wait runs out, and with RequestAbandonedError
   * when `signal` fires — which also drops the waiter, so those behind it move
   * up rather than waiting out a request that no longer exists.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new RequestAbandonedError()
    if (this.active < this.max) {
      this.active++
      return
    }
    if (this.waiters.length >= this.maxWaiting) {
      throw new TooManyRequestsError('Too many concurrent queries; please retry shortly')
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, settle: () => {} }
      const timer = setTimeout(() => {
        this.drop(waiter)
        reject(new TooManyRequestsError('Timed out waiting for a query slot; please retry shortly'))
      }, this.waitMs)
      const onAbort = () => {
        this.drop(waiter)
        reject(new RequestAbandonedError())
      }
      waiter.settle = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  /** Release a slot, handing it to the longest-waiting caller if there is one. */
  release(): void {
    const next = this.waiters.shift()
    if (next) {
      // The slot moves rather than frees, so `active` is unchanged
      next.settle()
      next.resolve()
      return
    }
    if (this.active > 0) this.active--
  }

  /** Currently held slots (for tests / observability). */
  get inUse(): number {
    return this.active
  }

  /** Callers waiting for a slot (for tests / observability). */
  get queued(): number {
    return this.waiters.length
  }

  private drop(waiter: Waiter): void {
    const i = this.waiters.indexOf(waiter)
    if (i >= 0) this.waiters.splice(i, 1)
    waiter.settle()
  }
}

/**
 * Shared by every in-process DuckDB user — ADR-032 resource queries and ADR-043
 * version diffs alike. They run in the same container and draw on the same
 * memory, so one budget covers both; two independent semaphores would each
 * think they had the whole container.
 */
const duckdbSemaphore = new Semaphore(QUERY_MAX_CONCURRENT, QUERY_QUEUE_MAX, QUERY_QUEUE_WAIT_MS)

/**
 * Run `fn` holding a DuckDB slot, queueing for one and rejecting with 429 only
 * once the queue is full. `signal` covers the wait as well as the run. The
 * release sits in a `finally` around everything the caller does — including
 * opening the session — because with a cap of one, a single leaked slot wedges
 * every later query.
 */
export async function withDuckdbSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await duckdbSemaphore.acquire(signal)
  try {
    // The wait takes time, and the caller granted a slot may have left during it
    if (signal?.aborted) throw new RequestAbandonedError()
    return await fn()
  } finally {
    duckdbSemaphore.release()
  }
}
