import { RequestAbandonedError } from '@kukan/shared'
import {
  QUERY_CALLER_MAX_ANONYMOUS,
  QUERY_CALLER_MAX_SIGNED_IN,
  QUERY_MAX_CONCURRENT,
  QUERY_QUEUE_MAX,
  QUERY_QUEUE_WAIT_MS,
} from '../../config'
import { CallerLimit, type Caller } from '../concurrency/caller-limit'
import { Semaphore } from '../concurrency/semaphore'

export type { Caller } from '../concurrency/caller-limit'

/**
 * Shared by the query paths — ADR-032 resource queries and ADR-043 version
 * diffs alike. They run in the same container and draw on the same memory, so
 * one budget covers both.
 *
 * **It is no longer the container's only DuckDB budget.** The OData feed holds
 * a second one beside it (ADR-055 §2), sized from the memory the process
 * actually has, and counts this one's slot at what it measured costing
 * (`QUERY_SLOT_RSS_MB`) before sizing itself. Written down because the sentence that
 * used to be here ("two independent semaphores would each think they had the
 * whole container") stopped being a rule and became a thing to watch.
 */
/** A refusal's Retry-After: a slot is held for seconds, not minutes. */
const QUERY_RETRY_AFTER_S = 1

const duckdbSemaphore = new Semaphore(
  QUERY_MAX_CONCURRENT,
  QUERY_QUEUE_MAX,
  QUERY_QUEUE_WAIT_MS,
  {
    full: 'Too many concurrent queries; please retry shortly',
    timedOut: 'Timed out waiting for a query slot; please retry shortly',
    retryAfterSeconds: QUERY_RETRY_AFTER_S,
  },
  // Signed-in callers go first, and anonymous ones may fill only half the queue
  { priorities: true }
)

/** Each caller's share of the slot and its queue (config §QUERY_CALLER_MAX_*). */
const queryCallerLimit = new CallerLimit(
  'Another query from this caller is still running; wait for it to finish',
  QUERY_RETRY_AFTER_S
)

/**
 * Run `fn` holding a DuckDB slot, queueing for one and rejecting with 429 only
 * once the queue is full. `signal` covers the wait as well as the run. The
 * release sits in a `finally` around everything the caller does — including
 * opening the session — because with a cap of one, a single leaked slot wedges
 * every later query.
 *
 * `caller` is who is asking, and decides two things: how many requests they may
 * have in flight here at once (counted before the queue, so the wait counts),
 * and that a signed-in caller takes the slot ahead of anonymous waiters. With
 * no caller, or one with neither a user nor an address, there is no cap and no
 * priority.
 */
export async function withDuckdbSlot<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
  caller?: Caller
): Promise<T> {
  const releaseCaller = queryCallerLimit.enter(
    caller,
    caller?.userId ? QUERY_CALLER_MAX_SIGNED_IN : QUERY_CALLER_MAX_ANONYMOUS
  )
  try {
    await duckdbSemaphore.acquire(signal, { priority: caller?.userId ? 'high' : 'normal' })
    try {
      // The wait takes time, and the caller granted a slot may have left during it
      if (signal?.aborted) throw new RequestAbandonedError()
      return await fn()
    } finally {
      duckdbSemaphore.release()
    }
  } finally {
    releaseCaller()
  }
}
