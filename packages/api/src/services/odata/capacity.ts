/**
 * How many feed pages this process may read at once (ADR-055).
 *
 * **Derived from the memory the process actually has**, because that is what
 * the number is a statement about: every page in flight holds a DuckDB
 * instance with {@link ODATA_MEMORY_LIMIT_BYTES} to spend, and the container is
 * 512 MB on the small scale and 2 GB on the large one. A fixed count is either
 * wasteful on the large or an overdraft on the small.
 *
 * The figure is read from the process rather than passed down from CDK, which
 * also knows it (`infra` sets `memoryLimitMiB` from the same scale): a cgroup
 * says what the kernel actually enforces, and it is the only answer that also
 * covers a Compose host.
 *
 * What is left after the query sandbox's own ceiling (ADR-032) and the process
 * itself is what these slots may spend — a share of the whole would double-book
 * the same megabytes, which is what it did before this.
 */

import { processMemory, type ProcessMemory } from '../../process-memory'
import { ODATA_MEMORY_LIMIT_BYTES, QUERY_MAX_CONCURRENT, QUERY_MEMORY_LIMIT_MB } from '../../config'

/**
 * What the rest of the process is assumed to need before a feed page gets any.
 *
 * The query sandbox's ceiling is real and reservable — `QUERY_MEMORY_LIMIT_MB`
 * times its own concurrency — and Node, Next, the connection pool and DuckDB's
 * own bookkeeping outside `memory_limit` take the rest. That second figure is
 * an estimate rather than a measurement of the production image, and it is the
 * conservative direction: too high costs a slot, too low costs the container.
 *
 * Subtracting rather than taking a share of the whole is the correction to what
 * this did first: 40% of 512 MB is three slots, which with the query path's 256
 * put 448 MB of DuckDB budget in a 512 MB task and left the process 64. The two
 * budgets still come from two places — one figure for both is the follow-up
 * issue on the query sandbox.
 */
const PROCESS_RESERVE_MB = 128

/**
 * Never fewer, so a second reader is never waiting on the first.
 *
 * It is a floor rather than a calculation, and on a container small enough it
 * would promise more than the share allows — 512 MB is the smallest this is
 * deployed on (infra `scale.small`), and there the arithmetic lands on two of
 * its own accord, so the floor only binds below that.
 */
const MIN_SLOTS = 2

/**
 * Never more, because past this the gain has flattened. Concurrency does buy
 * throughput — the S3 range reads overlap — but not much of it, and less the
 * wider the table: eight pages at once measured 1.61× the throughput of running
 * them one after another on a 7-column table and 1.24× on a 56-column one, with
 * the curve flat from four. What does not overlap is the serialization, and a
 * web task has one or two cores to do it on.
 */
const MAX_SLOTS = 8

export interface Capacity {
  slots: number
  memoryMb: number
  /** Where the memory figure came from, for the line this is logged on. */
  source: ProcessMemory['source']
}

/**
 * The slot's budget in decimal megabytes, which is what DuckDB's `memory_limit`
 * counts in. The process memory it is divided into is reported in MiB, so the
 * slot count comes out about 5% conservative — the safe direction, and left so
 * rather than mixing a third unit in. Stated once so the test that pins the
 * curve cannot agree with a stale copy.
 */
export const SLOT_MB = ODATA_MEMORY_LIMIT_BYTES / 1_000_000

/** Slots for `memoryMb` of process memory; exported for the test that pins the curve. */
export function slotsForMemory(memoryMb: number): number {
  const budgetMb = memoryMb - QUERY_MEMORY_LIMIT_MB * QUERY_MAX_CONCURRENT - PROCESS_RESERVE_MB
  return Math.max(MIN_SLOTS, Math.min(MAX_SLOTS, Math.floor(budgetMb / SLOT_MB)))
}

/** Read once: the limit does not change under a running process. */
export const capacity: Capacity = (() => {
  const { memoryMb, source } = processMemory()
  return { slots: slotsForMemory(memoryMb), memoryMb, source }
})()
