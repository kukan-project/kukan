/**
 * How many feed pages this process may read at once (ADR-055).
 *
 * **Derived from the memory the container actually has**, because that is what
 * the number is a statement about: every page in flight holds a DuckDB
 * instance with {@link ODATA_MEMORY_LIMIT_BYTES} to spend, and the container is
 * 512 MB on the small scale and 2 GB on the large one. A fixed count is either
 * wasteful on the large or an overdraft on the small.
 *
 * The figure is read from the cgroup rather than passed down from CDK, which
 * also knows it (`infra` sets `memoryLimitMiB` from the same scale): a cgroup
 * says what the kernel actually enforces, and it is the only answer that also
 * covers a Compose host.
 *
 * What is left after a query slot at its measured cost (ADR-032) and the web
 * server itself is what these slots may spend — a share of the whole would
 * double-book the same megabytes, which is what it did before this.
 */

import { processMemory, type ProcessMemory } from '../../process-memory'
import { ODATA_MEMORY_LIMIT_BYTES, QUERY_MAX_CONCURRENT, QUERY_SLOT_RSS_MB } from '../../config'

/**
 * What the rest of the container is assumed to need before a feed page gets any.
 *
 * The query path is counted at what a slot measured costing the container
 * (`QUERY_SLOT_RSS_MB`) times its concurrency, and Node, Next and the
 * connection pool take this. That second figure is an estimate rather than a
 * measurement of the production image, and it is the conservative direction:
 * too high costs a slot, too low costs the container.
 *
 * A resource query runs in a process of its own, but in the same cgroup, and
 * its peak there measured only 6 MB above the slot's (`QUERY_PROCESS_BASE_MB`),
 * so the slot is still what it costs the container.
 *
 * Subtracting rather than taking a share of the whole is the correction to what
 * this did first: 40% of 512 MB is three slots, which with the query path's 256
 * put 448 MB of DuckDB budget in a 512 MB task and left the process 64.
 */
const PROCESS_RESERVE_MB = 128

/**
 * Never fewer, so a second reader is never waiting on the first.
 *
 * It is a floor rather than a calculation, and it binds on the smallest scale
 * this is deployed on: a 512 MB task (infra `scale.small`) has no room for a
 * feed page once a query slot is counted at its measured cost (498 MB), and
 * gets two anyway. The feed alone fits there — a page measured 55–65 MB of RSS
 * with its kept instance, about the slot's budget — but a worst-case query does
 * not, with pages beside it or without them.
 */
const MIN_SLOTS = 2

/**
 * Never more, because past this the gain has flattened. Concurrency does buy
 * throughput — the S3 range reads overlap — but not much of it, and less the
 * wider the table: eight pages at once measured 1.61× the throughput of running
 * them one after another on a 7-column table and 1.24× on a 56-column one, with
 * the curve flat from four. What does not overlap is the serialization, and a
 * web task has one or two cores to do it on.
 *
 * Measured again with instances kept between pages (`feed-pool.ts`): 1.64× at
 * four, 1.63× at eight. Eight rather than four only because that was against a
 * local object store with no round trip to overlap; S3's may still pay past
 * four, which is worth measuring before this comes down.
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
 * counts in. The container memory it is divided into is reported in MiB, so the
 * slot count comes out about 5% conservative — the safe direction, and left so
 * rather than mixing a third unit in. Stated once so the test that pins the
 * curve cannot agree with a stale copy.
 */
export const SLOT_MB = ODATA_MEMORY_LIMIT_BYTES / 1_000_000

/** Slots for `memoryMb` of container memory; exported for the test that pins the curve. */
export function slotsForMemory(memoryMb: number): number {
  const budgetMb = memoryMb - QUERY_SLOT_RSS_MB * QUERY_MAX_CONCURRENT - PROCESS_RESERVE_MB
  return Math.max(MIN_SLOTS, Math.min(MAX_SLOTS, Math.floor(budgetMb / SLOT_MB)))
}

/** Read once: the limit does not change under a running process. */
export const capacity: Capacity = (() => {
  const { memoryMb, source } = processMemory()
  return { slots: slotsForMemory(memoryMb), memoryMb, source }
})()
