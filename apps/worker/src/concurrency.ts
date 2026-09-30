/**
 * How many jobs one worker runs at once (ADR-058 §7).
 *
 * Bound by the pool first: each running job needs a connection of its own,
 * and two more are spoken for — the embed run's second, which it takes while
 * holding its lock, and the queue's timers and the crons. Short of that, jobs
 * wait on the pool rather than stall, but the embed run can time out.
 *
 * Hence the pool's default of 5 (`WORKER_DB_POOL_MAX`, and the small preset):
 * three connections can be held for long — the embed run's, and whoever holds
 * or waits for the lake-ingest or the search-document lock — plus the embed
 * run's second and one for everything short. Fewer, and the long holders can
 * fill the pool and time the rest out.
 *
 * Bound by the cap second, when nothing is asked: the AI provider's rate
 * limits, not connections, are what a larger pool would run into.
 */

/** Connections the worker needs besides one per running job. */
export const POOL_RESERVE = 2

/** The most jobs run at once unless `WORKER_CONCURRENCY` asks for more. */
export const CONCURRENCY_CAP = 4

export function jobConcurrency(
  poolMax: number,
  asked?: number
): { concurrency: number; warning?: string } {
  const fits = Math.max(1, poolMax - POOL_RESERVE)
  if (asked === undefined) return { concurrency: Math.min(fits, CONCURRENCY_CAP) }
  return {
    concurrency: asked,
    ...(asked > fits && {
      warning:
        `WORKER_CONCURRENCY=${asked} needs a pool of ${asked + POOL_RESERVE}; ` +
        `WORKER_DB_POOL_MAX=${poolMax} fits ${fits}. Jobs will wait on the pool, ` +
        'and the embed run can time out waiting for its second connection',
    }),
  }
}
