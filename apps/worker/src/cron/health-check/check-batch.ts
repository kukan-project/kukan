/**
 * Health check batch processor.
 *
 * Queries stale resources, checks each with a HEAD request under a budget the
 * batch keeps per host, updates the row, and enqueues the ones that changed.
 * What the budget is for, and what it costs, is in `@/config` beside the
 * numbers it is made of.
 */

import { setTimeout as delay } from 'node:timers/promises'
import pLimit, { type LimitFunction } from 'p-limit'
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { Logger } from '@kukan/shared'
import { PIPELINE_JOB_TYPE, checkUrlSafety, normalizeHostname } from '@kukan/shared'
import {
  HEALTH_CHECK_BATCH_BUDGET_MS,
  HEALTH_CHECK_BATCH_SIZE,
  HEALTH_CHECK_CONCURRENCY,
  HEALTH_CHECK_PER_HOST_CONCURRENCY,
  HEALTH_CHECK_PER_HOST_INTERVAL_MS,
  HEALTH_CHECK_TIMEOUT_MS,
} from '@/config'
import { executeHeadCheck } from './head-request'
import type { ResourceForHealthCheck, BatchSummary } from './types'

/**
 * How many of one host's requests may be in flight.
 *
 * `p-limit` cannot express it: it owns the call, so a caller cannot hold a slot
 * across something it does not wrap — and every holder here spans a redirect
 * chain it does not own. The same shape as `Semaphore` in the API's query
 * sandbox, which this cannot import (that package does not export it, and it
 * carries a queue bound and a 429 with it); worth folding into `@kukan/shared`
 * the next time either needs changing.
 */
class HostSlots {
  private taken = 0
  private readonly waiting = new Set<(got: boolean) => void>()

  constructor(private readonly max: number) {}

  /**
   * A slot, waited for until `before` and then given up on.
   *
   * Every wait has a deadline, because a request waits for one host's slot
   * while holding another's: two rows redirecting into each other would
   * otherwise close a cycle that nothing opens again. A clock is what makes
   * that a delay rather than a deadlock.
   */
  async take(before: number): Promise<boolean> {
    if (this.taken < this.max) {
      this.taken++
      return true
    }
    const wait = before - Date.now()
    if (wait <= 0) return false
    return new Promise<boolean>((resolve) => {
      const waiter = (got: boolean) => {
        clearTimeout(expiry)
        this.waiting.delete(waiter)
        resolve(got)
      }
      const expiry = setTimeout(() => waiter(false), wait)
      this.waiting.add(waiter)
    })
  }

  /**
   * Handed to the next waiter rather than freed, so a caller arriving between
   * the wake and the waiter's own count cannot take the slot from under it.
   */
  release(): void {
    const next = this.waiting.values().next()
    if (!next.done) next.value(true)
    else if (this.taken > 0) this.taken--
  }
}

/**
 * What one batch owes each host it reaches, and what it owes the tick.
 *
 * A batch's URLs are not spread evenly over hosts, so a limit that counts only
 * requests points most of them at whichever host the catalog happens to be
 * built on. Two bounds per host, because neither implies the other: the slots
 * cap what is in flight, which is what an unresponsive host can take from the
 * batch, and the turn caps how often a request leaves, which is what the host
 * on the other end feels.
 *
 * Both are here rather than one here and one at the call site, because the
 * order they compose in is the whole design and neither reads as a decision on
 * its own — see {@link run}.
 *
 * Held for the life of one batch, and one process. Ticks are minutes apart, so
 * a turn carried between them would only ever have expired; worker tasks do not
 * see each other at all, which is what {@link
 * HEALTH_CHECK_PER_HOST_INTERVAL_MS} records.
 */
class HostBudget {
  private readonly perHost = new Map<string, HostSlots>()
  private readonly turnstile = new Map<string, HostSlots>()
  private readonly lastSent = new Map<string, number>()

  constructor(
    private readonly overall: LimitFunction,
    private readonly startsBefore: number
  ) {}

  /** Shared with {@link HostLease}, which holds these across a redirect. */
  slotsFor(hostname: string): HostSlots {
    return this.limiterFor(this.perHost, hostname, HEALTH_CHECK_PER_HOST_CONCURRENCY)
  }

  private limiterFor(of: Map<string, HostSlots>, hostname: string, max: number): HostSlots {
    let slots = of.get(hostname)
    if (!slots) {
      slots = new HostSlots(max)
      of.set(hostname, slots)
    }
    return slots
  }

  /**
   * Run `work` when this host's turn comes round, or answer null if the batch's
   * budget runs out before it does.
   *
   * The host's slot is taken first and the overall slot second: taken the other
   * way round, a batch read in staleness order — which puts one host's URLs
   * together — fills every overall slot with tasks waiting on the same host,
   * and nothing else in the batch is ever asked. Ahead of the overall slot, a
   * host can offer it only as many tasks as its own count allows.
   *
   * The wait for the turn, though, is taken *inside* the overall slot, and this
   * is not interchangeable: a request paced before queueing for a slot is paced
   * against the moment it joined the queue, not the moment it leaves, and the
   * queue releases what it holds together.
   */
  async run<T>(hostname: string, work: () => Promise<T>): Promise<T | null> {
    const slots = this.slotsFor(hostname)
    if (!(await slots.take(this.startsBefore))) return null
    try {
      return await this.overall(async () =>
        (await this.reserve(hostname, this.startsBefore)) ? work() : null
      )
    } finally {
      slots.release()
    }
  }

  /**
   * A hold on every host one request touches, given up together when it ends.
   *
   * For the hosts a redirect reaches, which no row named and which nothing
   * would otherwise pace: many rows redirecting to one CDN is the whole
   * per-host budget bypassed by exactly the kind of host it was measured
   * against.
   *
   * `before` is the last moment a hop may still be *started*, which is not the
   * moment the request gives up. A hop that leaves with almost none of the
   * timeout left is answered by its own abort, and a live URL is written down
   * as a dead link — the failure this whole change exists to stop.
   */
  lease(before: number): HostLease {
    return new HostLease(this, Math.min(before, this.startsBefore))
  }

  /**
   * Wait for this host's turn, or answer false if it will not come before
   * `before`.
   *
   * One waiter per host at a time, and the moment recorded is the one it woke
   * at rather than the one it aimed for: reserved ahead of the wait, several
   * turns fall due together when the event loop stops and the requests they
   * were pacing leave together on the other side of it.
   */
  async reserve(hostname: string, before: number): Promise<boolean> {
    const turn = this.limiterFor(this.turnstile, hostname, 1)
    if (!(await turn.take(before))) return false
    try {
      const last = this.lastSent.get(hostname)
      const at =
        last === undefined
          ? Date.now()
          : Math.max(Date.now(), last + HEALTH_CHECK_PER_HOST_INTERVAL_MS)
      // Tested against the turn rather than after waiting it out, or every row
      // refused would still cost an interval to refuse.
      if (at > before) return false
      const wait = at - Date.now()
      if (wait > 0) await delay(wait)
      // And tested again on waking, because the first test was a prediction: a
      // timer that comes back after the event loop stopped comes back late.
      // Nothing left, so the host is owed nothing either.
      if (Date.now() > before) return false
      this.lastSent.set(hostname, Date.now())
      return true
    } finally {
      turn.release()
    }
  }
}

/** What one request holds on the hosts its redirects reached. */
class HostLease {
  private readonly held: HostSlots[] = []

  constructor(
    private readonly budget: HostBudget,
    private readonly before: number
  ) {}

  /**
   * What `safeFetch` asks at each host the chain has not used yet.
   *
   * The slot is waited for, but only for about as long as one turn takes: long
   * enough that a target serving at the rate it is allowed hands one over,
   * short enough that the queue for an unresponsive one does not become the
   * batch's queue — every waiter here is holding an overall slot as well.
   * Refused outright instead, a batch of rows on distinct hosts behind one CDN
   * spends every one of its requests to record almost none of them.
   *
   * Taken before the turn: after it, a hop refused for want of a slot would
   * have spent the host's pacing on a request that never goes out.
   */
  async take(hostname: string): Promise<boolean> {
    const slots = this.budget.slotsFor(hostname)
    const waitUntil = Math.min(this.before, Date.now() + HEALTH_CHECK_PER_HOST_INTERVAL_MS)
    if (!(await slots.take(waitUntil))) return false
    this.held.push(slots)
    return this.budget.reserve(hostname, this.before)
  }

  release(): void {
    for (const slots of this.held) slots.release()
    this.held.length = 0
  }
}

/**
 * Run a single health check batch:
 * 1. SELECT stale external URL resources
 * 2. HEAD check each, bounded overall and per host, within the batch's budget
 * 3. UPDATE health status in DB
 * 4. Enqueue changed resources (or no-header resources due for full fetch) to pipeline
 */
export async function checkBatch(
  db: Database,
  queue: QueueAdapter,
  stalenessHours: number,
  fullFetchIntervalHours: number,
  log: Logger
): Promise<BatchSummary> {
  const summary: BatchSummary = {
    total: 0,
    checked: 0,
    ok: 0,
    error: 0,
    changed: 0,
    enqueuedForFullFetch: 0,
    deferred: 0,
  }

  // 1. SELECT stale resources using healthCheckedAt as implicit cursor
  const staleThreshold = sql`NOW() - ${`${stalenessHours} hours`}::interval`

  const batch = await db
    .select({
      id: resource.id,
      url: resource.url,
      hash: resource.hash,
      healthStatus: resource.healthStatus,
      healthCheckedAt: resource.healthCheckedAt,
      extras: resource.extras,
    })
    .from(resource)
    .where(
      and(
        isNull(resource.urlType),
        eq(resource.state, 'active'),
        sql`${resource.url} IS NOT NULL`,
        or(isNull(resource.healthCheckedAt), lt(resource.healthCheckedAt, staleThreshold))
      )
    )
    // `id` breaks the tie so the order is the same from one tick to the next:
    // rows the budget deferred share a `healthCheckedAt` with the rows around
    // them, and without it the tail that gets deferred is a different set each
    // time rather than the one the last tick stopped at.
    .orderBy(sql`${resource.healthCheckedAt} ASC NULLS FIRST`, resource.id)
    .limit(HEALTH_CHECK_BATCH_SIZE)

  summary.total = batch.length

  if (batch.length === 0) {
    log.debug('No stale resources to check')
    return summary
  }

  log.info({ count: batch.length }, 'Starting health check batch')

  // 2. Run HEAD checks, bounded overall and per host, within the batch's budget
  const overall = pLimit(HEALTH_CHECK_CONCURRENCY)
  const hosts = new HostBudget(overall, Date.now() + HEALTH_CHECK_BATCH_BUDGET_MS)
  const fullFetchThreshold = fullFetchIntervalHours * 60 * 60 * 1000

  const tasks = batch.map(async (row) => {
    // Asked before the budget rather than left to `safeFetch`, which asks the
    // same question and refuses before reaching a socket: a row that is never
    // going to be requested would otherwise take a place in its host's queue
    // and be paced through it, and two hundred `ftp:` rows on one host would
    // spend the batch's whole budget on requests nobody makes. Rows like that
    // predate the check the API applies at input, or arrived by import.
    const unsafe = checkUrlSafety(row.url!)
    if (unsafe) {
      // Bounded all the same, though it asks nothing of the network: two
      // hundred of these are two hundred writes at once against a pool of
      // three.
      await overall(() => updateHealthStatus(db, row.id, 'error', { healthError: unsafe.message }))
      summary.checked++
      summary.error++
      return
    }
    // It parsed, or `checkUrlSafety` would have said so.
    const { hostname } = new URL(row.url!)

    const res: ResourceForHealthCheck = {
      id: row.id,
      url: row.url!,
      hash: row.hash,
      healthStatus: row.healthStatus,
      healthCheckedAt: row.healthCheckedAt,
      extras: (row.extras as Record<string, unknown>) ?? {},
    }

    // The writes are inside the budget with the request, not after it: they go
    // to a pool of three connections shared with the pipeline.
    const started = await hosts.run(normalizeHostname(hostname), async () => {
      // Every host the chain reaches is held and paced, not only the one the
      // row named — and given up together when the request ends, whichever way
      // it ended.
      // Half of what the request is given, because the bound is on starting a
      // hop rather than on finishing one: a hop that leaves with a sliver of
      // the timeout left is answered by its own abort.
      const lease = hosts.lease(Date.now() + HEALTH_CHECK_TIMEOUT_MS / 2)
      let result: Awaited<ReturnType<typeof executeHeadCheck>>
      try {
        result = await executeHeadCheck(res, { onHost: (host) => lease.take(host) })
      } finally {
        lease.release()
      }
      if (result === null) return false
      summary.checked++

      if (result.healthStatus === 'ok') {
        summary.ok++
      } else {
        summary.error++
        if (result.errorDetail) {
          log.warn(
            { resourceId: res.id, url: res.url, detail: result.errorDetail },
            'Health check failed'
          )
        }
      }

      // 3. Update DB: healthStatus, healthCheckedAt, extras (jsonb merge)
      const healthMeta: Record<string, unknown> = {}
      if (result.etag !== null) healthMeta.healthEtag = result.etag
      if (result.lastModified !== null) healthMeta.healthLastModified = result.lastModified
      healthMeta.healthError = result.errorMessage
      if (result.httpStatus !== null) healthMeta.healthHttpStatus = result.httpStatus

      const hasHeaders = result.etag !== null || result.lastModified !== null

      await updateHealthStatus(db, res.id, result.healthStatus, healthMeta)

      // 4a. Enqueue changed resources to pipeline for re-fetch
      if (result.changed) {
        summary.changed++
        log.info(
          { resourceId: res.id, etag: result.etag, lastModified: result.lastModified },
          'Resource changed, enqueueing to pipeline'
        )
        await queue.enqueue(PIPELINE_JOB_TYPE, { resourceId: res.id })
        return true
      }

      // 4b. No-header resources: periodic full fetch for hash comparison
      if (result.healthStatus === 'ok' && !hasHeaders) {
        const lastFullFetch = res.extras.healthLastFullFetchAt as number | undefined
        const needsFullFetch =
          lastFullFetch === undefined || Date.now() - lastFullFetch > fullFetchThreshold

        if (needsFullFetch) {
          summary.enqueuedForFullFetch++
          log.info({ resourceId: res.id }, 'No change headers, enqueueing periodic full fetch')
          await queue.enqueue(PIPELINE_JOB_TYPE, { resourceId: res.id })
          // Record the enqueue time so we don't re-enqueue until next interval
          await updateHealthStatus(db, res.id, null, { healthLastFullFetchAt: Date.now() })
        }
      }
      return true
    })

    // Its turn, or a redirect target's, fell outside the budget — so it was
    // never asked, and nothing about it was recorded.
    if (started !== true) summary.deferred++
  })

  // Settled rather than all: one row whose write failed used to abandon every
  // other row's — the rest of the batch went on requesting, with nothing left
  // to record it and no summary to say so.
  const outcomes = await Promise.allSettled(tasks)
  const failures = outcomes.filter((o) => o.status === 'rejected')
  if (failures.length > 0) {
    log.error(
      { failed: failures.length, err: failures[0].reason },
      'Health check rows could not be recorded'
    )
  }

  log.info(summary, 'Health check batch complete')

  return summary
}

/** Update resource health extras, and optionally healthStatus + healthCheckedAt */
async function updateHealthStatus(
  db: Database,
  resourceId: string,
  healthStatus: 'ok' | 'error' | null,
  healthMeta: Record<string, unknown>
): Promise<void> {
  const metaJson = JSON.stringify(healthMeta)
  await db
    .update(resource)
    .set({
      ...(healthStatus !== null && { healthStatus, healthCheckedAt: sql`NOW()` }),
      extras: sql`COALESCE(${resource.extras}, '{}'::jsonb) || ${metaJson}::jsonb`,
    })
    .where(eq(resource.id, resourceId))
}
