import { RequestAbandonedError } from '@kukan/shared'
import { QUERY_MAX_CONCURRENT, QUERY_QUEUE_MAX, QUERY_QUEUE_WAIT_MS } from '../../config'
import { Semaphore } from '../semaphore'

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
const duckdbSemaphore = new Semaphore(QUERY_MAX_CONCURRENT, QUERY_QUEUE_MAX, QUERY_QUEUE_WAIT_MS, {
  full: 'Too many concurrent queries; please retry shortly',
  timedOut: 'Timed out waiting for a query slot; please retry shortly',
})

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
