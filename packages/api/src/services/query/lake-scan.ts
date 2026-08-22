/**
 * Reading DuckLake from the web container, under bounds (ADR-032 Part B's, over
 * ADR-043's lake).
 *
 * A version diff and a key check both scan content this process did not choose
 * the size of, on a request a screen can fire repeatedly. Neither can be left to
 * run as long as it likes on as much memory as it likes: they share one slot
 * with every ADR-032 query, so an unbounded scan is not slow for its own caller
 * — it is 429 for everyone behind it.
 *
 * The bounds are one mechanism rather than one per caller because the ordering
 * between them is where the leaks are, and it is not obvious: the deadline has
 * to cover session setup, the interrupt has to reach a session that may not
 * exist yet, and the close has to wait for the interrupted scan to unwind.
 */
import type { LakeConfig, LakeSession } from '@kukan/lake'
import { openLakeSession } from '@kukan/lake'
import { RequestAbandonedError, RequestTimeoutError } from '@kukan/shared'
import { withDuckdbSlot } from './semaphore'
import { QUERY_MEMORY_LIMIT_MB, QUERY_THREADS, QUERY_TIMEOUT_MS } from '../../config'

/**
 * Run `scan` against a lake session, holding one shared DuckDB slot, capped in
 * memory and threads, and stopped by whichever comes first of a wall-clock
 * deadline and the caller giving up.
 *
 * `what` names the operation in the timeout message — the only thing a caller
 * needs to say about how it wants to be bounded.
 *
 * The slot is released in a `finally` that covers session setup too: with a cap
 * of one, a single failed ATTACH would otherwise wedge every later scan *and*
 * every ADR-032 query at 429 for the process's lifetime.
 */
export async function scanLake<T>(
  lake: LakeConfig,
  what: string,
  scan: (session: LakeSession) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  return withDuckdbSlot(async () => {
    let session: LakeSession | null = null
    let scanning: Promise<T> | null = null

    // Two reasons to stop, one mechanism: the run outlived its budget, or its
    // caller did not wait for it. The deadline covers session setup too — the
    // extension load and catalog ATTACH are network work, and with a cap of one
    // slot a hung setup would hold every later query behind it.
    const deadline = AbortSignal.timeout(QUERY_TIMEOUT_MS)
    const halt = signal ? AbortSignal.any([signal, deadline]) : deadline
    /** Why the scan was stopped, if it was: the interrupt makes the scan itself
     *  reject too, and that can win the race with `stopped`. */
    const haltReason = () =>
      deadline.aborted
        ? new RequestTimeoutError(`${what} exceeded the time limit of ${QUERY_TIMEOUT_MS} ms`)
        : signal?.aborted
          ? new RequestAbandonedError()
          : null

    let stop!: (err: Error) => void
    const stopped = new Promise<never>((_, reject) => {
      stop = reject
    })
    halt.addEventListener(
      'abort',
      () => {
        session?.interrupt()
        stop(haltReason()!)
      },
      { once: true }
    )

    // Held separately from `session` so a setup that lands after the deadline is
    // still closed rather than leaked.
    const opening = openLakeSession(lake, {
      memoryLimitMb: QUERY_MEMORY_LIMIT_MB,
      threads: QUERY_THREADS,
    }).then((s) => (session = s))

    try {
      await Promise.race([opening, stopped])
      scanning = scan(session!)
      return await Promise.race([scanning, stopped])
    } catch (err) {
      throw haltReason() ?? err
    } finally {
      // Not awaited: a setup that hung past the deadline must not hold the
      // response or the shared slot. It is closed whenever it lands — after the
      // interrupted scan unwinds, because disconnecting in the same tick as the
      // interrupt leaves its promise pending forever (measured against the
      // driver). Interrupted alone it rejects at once, so this is free.
      void opening
        .then(async (s) => {
          await scanning?.catch(() => {})
          await s.close()
        })
        .catch(() => {})
    }
  }, signal)
}
