/**
 * How many requests one caller may have in flight on a pool — running or
 * waiting in its semaphore's queue. The semaphores bound the pool as a whole;
 * this bounds each caller's share of it, which is what keeps one caller from
 * holding the DuckDB slot (ADR-032 Part B) or the feed (ADR-055) in a loop.
 *
 * Counted in flight rather than per minute on purpose: a 15-second query four
 * times a minute keeps a single slot busy without touching any per-minute
 * figure. Request counting is the edge's job.
 */
import { addressKey, TooManyRequestsError } from '@kukan/shared'

/** Who is asking: the user when signed in, otherwise the address the request came from. */
export interface Caller {
  userId?: string
  ip?: string
}

/**
 * The key a caller's requests are counted under: the user, or failing that the
 * address — folded to its /64 for IPv6, since one host there has 2^64 of them.
 * `undefined` for a caller with neither: counting every such request under one
 * key would have them cap each other, so they go uncapped instead.
 */
export function callerKey(caller: Caller): string | undefined {
  if (caller.userId) return `user:${caller.userId}`
  const bucket = caller.ip && ipBucket(caller.ip)
  return bucket ? `ip:${bucket}` : undefined
}

/**
 * The address one caller's requests are counted under: an IPv4 whole, an IPv6
 * by its first 8 bytes (its /64), an IPv4 carried inside IPv6 (`::ffff:a.b.c.d`)
 * as that IPv4. `undefined` when `ip` is not an address.
 */
export function ipBucket(ip: string): string | undefined {
  const bytes = addressKey(ip)?.split('.')
  if (!bytes) return undefined
  return bytes.length === 4 ? bytes.join('.') : `${bytes.slice(0, 8).join('.')}/64`
}

export class CallerLimit {
  private readonly inFlight = new Map<string, number>()

  constructor(
    /** The 429's detail, in the words of whoever the caller is being refused by. */
    private readonly busy: string,
    /** What the refusal advises as Retry-After: how long the pool's requests tend to run. */
    private readonly retryAfterSeconds: number
  ) {}

  /**
   * Count one more request against `key`, refusing with 429 when it already
   * has `limit` in flight. Returns the release, which the caller runs once the
   * request is done — after the semaphore it then queues for is released, so
   * the count covers the wait as well as the run.
   */
  acquire(key: string, limit: number): () => void {
    const held = this.inFlight.get(key) ?? 0
    if (held >= limit) throw new TooManyRequestsError(this.busy, this.retryAfterSeconds)
    this.inFlight.set(key, held + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const now = (this.inFlight.get(key) ?? 1) - 1
      if (now <= 0) this.inFlight.delete(key)
      else this.inFlight.set(key, now)
    }
  }

  /** Requests in flight under `key` (for tests / observability). */
  held(key: string): number {
    return this.inFlight.get(key) ?? 0
  }
}
