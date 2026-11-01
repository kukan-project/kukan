/**
 * Bounded counting semaphore for in-process DuckDB work — the query paths
 * (ADR-032 Part B, `query/duckdb-slot.ts`) and the OData feed (ADR-055) each hold
 * one.
 *
 * Bounds how many run at once so their memory stays within the web container.
 * Callers queue rather than being refused on contention: with a cap of one,
 * refusing made a 429 out of any two overlapping requests. The queue is bounded
 * in both depth and per-caller wait, so 429 means a backlog rather than a
 * coincidence.
 *
 * With `priorities` on, two queues rather than one: a freed slot goes to a
 * high-priority waiter ahead of any normal one, and normal waiters may fill
 * only half the queue. The query path marks signed-in callers high, so a flood
 * of anonymous requests neither keeps them out of the queue nor serves them
 * last. Off — the feed, the passage search — the queue is one FIFO of the
 * full depth.
 */
import { RequestAbandonedError, TooManyRequestsError } from '@kukan/shared'

export type Priority = 'high' | 'normal'

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
  /** Clears this waiter's timer and abort listener. */
  settle: () => void
}

export class Semaphore {
  private active = 0
  private readonly waiters: Record<Priority, Waiter[]> = { high: [], normal: [] }
  /** Queue depth normal-priority waiters may take between them. */
  private readonly maxNormalWaiting: number

  constructor(
    private readonly max: number,
    private readonly maxWaiting: number,
    private readonly waitMs: number,
    /** The 429's detail, in the words of whoever the caller is waiting for, and
     *  what it advises as Retry-After: how long a slot tends to be held. */
    private readonly busy: { full: string; timedOut?: string; retryAfterSeconds: number },
    /** Whether `acquire` is told a priority; keeps half the queue for high when so. */
    { priorities = false }: { priorities?: boolean } = {}
  ) {
    this.maxNormalWaiting = priorities ? Math.ceil(maxWaiting / 2) : maxWaiting
  }

  /**
   * Reserve a slot, waiting in FIFO order within its priority for one to free
   * up. Rejects with 429 when the queue is full (with priorities on, for a
   * normal-priority caller, when the normal share of it is) or the wait runs
   * out, and with RequestAbandonedError when `signal` fires — which also drops
   * the waiter, so those behind it move up rather than waiting out a request
   * that no longer exists.
   */
  async acquire(signal?: AbortSignal, { priority = 'normal' }: { priority?: Priority } = {}) {
    if (signal?.aborted) throw new RequestAbandonedError()
    if (this.active < this.max) {
      this.active++
      return
    }
    const queue = this.waiters[priority]
    if (
      this.queued >= this.maxWaiting ||
      (priority === 'normal' && queue.length >= this.maxNormalWaiting)
    ) {
      throw new TooManyRequestsError(this.busy.full, this.busy.retryAfterSeconds)
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, settle: () => {} }
      const timer = setTimeout(() => {
        this.drop(waiter)
        reject(
          new TooManyRequestsError(
            this.busy.timedOut ?? this.busy.full,
            this.busy.retryAfterSeconds
          )
        )
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
      queue.push(waiter)
    })
  }

  /** Release a slot, handing it to the longest-waiting high-priority caller,
   *  then the longest-waiting normal one, if there is one. */
  release(): void {
    const next = this.waiters.high.shift() ?? this.waiters.normal.shift()
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

  /** Callers waiting for a slot, at either priority (for tests / observability). */
  get queued(): number {
    return this.waiters.high.length + this.waiters.normal.length
  }

  private drop(waiter: Waiter): void {
    for (const queue of Object.values(this.waiters)) {
      const i = queue.indexOf(waiter)
      if (i >= 0) queue.splice(i, 1)
    }
    waiter.settle()
  }
}
