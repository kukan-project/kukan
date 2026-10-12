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
import type {
  BucketSession,
  LakeCatalogReaderOptions,
  LakeConfig,
  LakeObjectStore,
  LakeSession,
} from '@kukan/lake'
import { lakeConfigFromEnv, openBucketSession, openLakeCatalogReader } from '@kukan/lake'
import type { Env } from '@kukan/shared'
import { RequestAbandonedError, RequestTimeoutError } from '@kukan/shared'
import { withDuckdbSlot } from './duckdb-slot'
import { QUERY_MEMORY_LIMIT_MB, QUERY_THREADS, QUERY_TIMEOUT_MS } from '../../config'

/**
 * The web's lake, bounded like the scans below — the only reason it opens
 * one. A dataset's purge queues its layer 2's deletion for the worker instead.
 */
export function webLakeConfig(env: Env): LakeConfig {
  return lakeConfigFromEnv(env, {
    memoryLimitMb: QUERY_MEMORY_LIMIT_MB,
    threads: QUERY_THREADS,
  })
}

/**
 * A scan of the bucket alone, which opens no catalog: the key check reads the
 * preview's Parquet, and opening a catalog for it would read nothing from it.
 */
export function scanBucket<T>(
  lake: LakeConfig,
  what: string,
  scan: (session: BucketSession) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  return scanWith(() => openBucketSession(lake), what, scan, signal)
}

/**
 * A scan of one resource's own catalog (ADR-067), downloaded and attached
 * read-only. The download is inside the bounds too: it is network work before
 * the scan, and a hung one must not hold the slot.
 */
export function scanCatalog<T>(
  lake: LakeConfig,
  store: LakeObjectStore,
  catalog: LakeCatalogReaderOptions,
  what: string,
  scan: (session: LakeSession) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  return scanWith(() => openLakeCatalogReader(lake, store, catalog), what, scan, signal)
}

/**
 * Run `scan` against a session, holding one shared DuckDB slot, capped in
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
async function scanWith<S extends BucketSession, T>(
  open: () => Promise<S>,
  what: string,
  scan: (session: S) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  return withDuckdbSlot(async () => {
    let session: S | null = null
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
    const opening = open().then((s) => (session = s))

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
