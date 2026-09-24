/**
 * Bounded counting semaphore for in-process DuckDB work — the query paths
 * (ADR-032 Part B, `query/semaphore.ts`) and the OData feed (ADR-055) each hold
 * one.
 *
 * Bounds how many run at once so their memory stays within the web container.
 * Callers queue rather than being refused on contention: with a cap of one,
 * refusing made a 429 out of any two overlapping requests. The queue is bounded
 * in both depth and per-caller wait, so 429 means a backlog rather than a
 * coincidence.
 */
import { RequestAbandonedError, TooManyRequestsError } from '@kukan/shared'

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
    private readonly waitMs: number,
    /** The 429's detail, in the words of whoever the caller is waiting for. */
    private readonly busy: { full: string; timedOut?: string }
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
      throw new TooManyRequestsError(this.busy.full)
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, settle: () => {} }
      const timer = setTimeout(() => {
        this.drop(waiter)
        reject(new TooManyRequestsError(this.busy.timedOut ?? this.busy.full))
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
