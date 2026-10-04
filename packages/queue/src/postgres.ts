/**
 * KUKAN PostgreSQL Job Queue (ADR-058)
 *
 * The jobs are rows of `job`, taken with `FOR UPDATE SKIP LOCKED` and held by a
 * lease. Nothing polls: a writer wakes the consumer after its commit, and the
 * consumer takes rows until none is ready, then holds no connection until the
 * next signal or the earliest delayed job comes due. Waiting in the database —
 * a poll, a held LISTEN — is what keeps Aurora Serverless v2 from pausing;
 * writing to it is not, since the writer has woken it anyway.
 */

import { AsyncLocalStorage } from 'async_hooks'
import { randomUUID } from 'crypto'
import { and, asc, desc, eq, gt, gte, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm'
import { job as jobTable, type Database, type Transaction } from '@kukan/db'
import { createLogger, type JobPriority, type JobStatus, type Logger } from '@kukan/shared'
import {
  JobInterruptedError,
  type EnqueueOptions,
  type Job,
  type JobRecord,
  type JobQueue,
} from './job-queue'

/**
 * How long a lease lasts, and how it is held while a handler runs.
 *
 * The terms the SQS queue this replaced gave (a 10-minute visibility timeout,
 * extended every two minutes, for 90 minutes at most): a handler that hangs
 * holds its job for `MAX_HOLD_MS` and no longer, and another worker may then
 * take it.
 */
const LEASE_S = 600
const HOLD_INTERVAL_MS = 120_000
const MAX_HOLD_MS = 90 * 60_000

/** Taken this many times without finishing, a job is dead. */
export const MAX_ATTEMPTS = 3

/** How long a failed job waits before it is taken again. */
const RETRY_DELAY_S = 300

/** Jobs per INSERT: well inside PostgreSQL's 65,535 bind parameters. */
const INSERT_BATCH_SIZE = 1000

/**
 * How often the waiting jobs are counted (`onWaiting`): the minute the worker
 * writes the figure on (`WAITING_METRIC_INTERVAL_MS`), so a busier count would
 * never be read.
 */
const WAITING_COUNT_MS = 60_000

/** How long after a pass that could not reach the database to try again. */
const DRAIN_RETRY_MS = 30_000

export interface PostgresJobQueueConfig {
  db: Database
  /**
   * How to reach the consumer from a process that is not it — the web's POST
   * to the worker. Unset, a writer relies on the consumer's own passes.
   */
  notify?: () => Promise<void>
  /**
   * Told how many jobs are waiting to be taken now, the ones a worker holds
   * included: for scaling on (ADR-058 §4). Counted only while this worker runs
   * a job, when the database is awake anyway — as the job is taken and once a
   * minute through it. An idle worker reports 0 and asks nothing.
   */
  onWaiting?: (count: number) => void
  /**
   * How many jobs this process runs at once (ADR-058 §7). Each takes the next
   * job, in priority order, as it finishes the last. Default 1.
   */
  concurrency?: number
  logger?: Logger
}

type Handlers = Record<string, (job: Job<unknown>) => Promise<void>>

/** A job as taken, with the priority its handler runs under. */
type Taken = Job & { priority: JobPriority }

const ready = () => eq(jobTable.state, 'ready')

/** The order jobs are taken in (ADR-058 §6); the admin screen lists them so too. */
const takeOrder = () => [asc(jobTable.priority), asc(jobTable.runAt), asc(jobTable.id)]
const due = () => lte(jobTable.runAt, sql`now()`)

/** Rows no worker holds: never leased, or leased by one that stopped answering. */
const unleased = () => or(isNull(jobTable.lockedUntil), lt(jobTable.lockedUntil, sql`now()`))

const inSeconds = (s: number) => sql`now() + ${`${s} seconds`}::interval`

/** A row's `JobStatus`, as the admin screen reads it. */
const jobStatus = () => sql<JobStatus>`case
  when ${jobTable.state} = 'dead' then 'dead'
  when ${jobTable.lockedUntil} >= now() then 'running'
  when ${jobTable.runAt} > now() then 'scheduled'
  else 'waiting'
end`

/**
 * The ready jobs of `type` whose payload names this resource, for an
 * `exists()`. Kept here so the table's shape stays with the queue; the index
 * `idx_job_ready_resource` serves it.
 */
export function readyJobsFor(db: Database | Transaction, type: string, resourceId: string) {
  return db
    .select({})
    .from(jobTable)
    .where(
      and(
        eq(jobTable.type, type),
        ready(),
        sql`${jobTable.payload} ->> 'resourceId' = ${resourceId}`
      )
    )
}

/**
 * The jobs of `type`, dead ones included, whose payload contains `match` (a
 * jsonb), for an `exists()`: whether anything, even given up on, stands behind
 * a claim.
 */
export function jobsFor(db: Database | Transaction, type: string, match: SQL) {
  return db
    .select({})
    .from(jobTable)
    .where(and(eq(jobTable.type, type), sql`${jobTable.payload} @> ${match}`))
}

/**
 * Run `fn` one call at a time. A request that arrives while it runs becomes
 * one more run after it, not a second one beside it: what it asks about may
 * have been written after the running call looked.
 */
function coalesced(fn: () => Promise<void>) {
  let running: Promise<void> | undefined
  let again = false
  const loop = async () => {
    try {
      do {
        again = false
        await fn()
      } while (again)
    } finally {
      // In the same step as the last check of `again`. Cleared in a callback
      // on the loop's promise instead, a request landing in between would find
      // it still running, set `again` for a loop already done, and be lost.
      running = undefined
    }
  }
  return {
    request(): void {
      if (running) {
        again = true
        return
      }
      running = loop()
    },
  }
}

export class PostgresJobQueue implements JobQueue {
  private db: Database
  private log: Logger
  private onWaiting?: (count: number) => void
  private waitingCountedAt = 0
  /** Jobs taken and not yet finished: while any are, a count may speak for them. */
  private running = 0
  /** A job was taken since every loop last stopped. */
  private tookSinceIdle = false
  /** Who holds a lease, so a worker that lost one cannot extend or delete it. */
  private readonly owner = randomUUID()
  /** Transactions a job was written in, to be woken for once they commit. */
  private readonly written = new WeakSet<Transaction>()
  /** The priority of the job whose handler is running, for what it writes. */
  private readonly runningPriority = new AsyncLocalStorage<JobPriority>()

  private handlers?: Handlers
  private stopped = false
  private timer?: ReturnType<typeof setTimeout>
  /** When `timer` fires. */
  private timerAt = Infinity
  private readonly concurrency: number
  /**
   * Loops taking jobs, at most `concurrency`. Counted down in the same step as
   * a loop's last look, so a request for a pass that comes after it starts a
   * new loop rather than finding the old one still counted.
   */
  private active = 0
  /** Loops and their closing work, for `stop` to wait out. */
  private readonly pending = new Set<Promise<void>>()
  /** No pass before this after one failed: armed sooner, it would fail again at once. */
  private backoffUntil = 0
  /** The minutely count while any job runs, one for all the loops. */
  private counting?: ReturnType<typeof setInterval>
  /**
   * Bumped by every request for a pass. A loop that found nothing takes
   * another look if it moved since that look began: the job it was asked
   * about may have been written after the look, and with every loop busy no
   * new one starts for it.
   */
  private wakes = 0
  /**
   * Sent one at a time: a burst of writes (a catalog-wide re-enqueue) would
   * otherwise be as many requests, and the worker needs only one after the
   * last write it has not seen, which the trailing send is.
   */
  private readonly signal?: ReturnType<typeof coalesced>
  private readonly notify?: () => Promise<void>

  constructor(config: PostgresJobQueueConfig) {
    this.db = config.db
    this.onWaiting = config.onWaiting
    this.concurrency = Math.max(1, Math.floor(config.concurrency ?? 1))
    this.log = config.logger ?? createLogger({ name: 'job-queue' })
    const notify = (this.notify = config.notify)
    if (notify) {
      this.signal = coalesced(async () => {
        try {
          await notify()
        } catch (err) {
          this.log.warn({ err }, 'Could not wake the worker; the job waits for its next pass')
        }
      })
    }
  }

  async enqueue<T>(type: string, data: T, options?: EnqueueOptions): Promise<string> {
    if (options?.unlessWaiting) {
      // Two statements: two callers can both find nothing and write one each,
      // which costs a job that finds its work already done
      const db = options.tx ?? this.db
      const standIn = db
        .select({ id: jobTable.id })
        .from(jobTable)
        .where(
          and(
            eq(jobTable.type, type),
            ready(),
            unleased(),
            eq(jobTable.attempts, 0),
            // The same work: a metadata-only rebuild is no stand-in for one
            // that re-indexes content
            sql`${jobTable.payload} = ${JSON.stringify(data ?? {})}::jsonb`,
            // No later than the one asked for: a job an hour out is no stand-in
            // for one wanted now
            lte(jobTable.runAt, inSeconds(options.delaySeconds ?? 0))
          )
        )
        .limit(1)
        .for('update', { skipLocked: true })
      // At any priority, raised to this one's: left behind the bulk runs, it
      // would hold back the caller who waits; passed over, the work runs twice
      const [waiting] = await db
        .update(jobTable)
        .set({
          priority: sql`least(${jobTable.priority}, ${this.priorityOf(options)}::job_priority)`,
        })
        .where(sql`${jobTable.id} = (${standIn})`)
        .returning({ id: jobTable.id })
      if (waiting) return waiting.id
    }
    const [id] = await this.enqueueMany(type, [data], options)
    return id
  }

  async enqueueMany<T>(type: string, data: T[], options?: EnqueueOptions): Promise<string[]> {
    const runAt = options?.delaySeconds ? inSeconds(options.delaySeconds) : undefined
    const priority = this.priorityOf(options)
    const ids: string[] = []
    for (let i = 0; i < data.length; i += INSERT_BATCH_SIZE) {
      const rows = await (options?.tx ?? this.db)
        .insert(jobTable)
        .values(
          data
            .slice(i, i + INSERT_BATCH_SIZE)
            .map((payload) => ({ type, payload: payload ?? {}, priority, ...(runAt && { runAt }) }))
        )
        .returning({ id: jobTable.id })
      ids.push(...rows.map((r) => r.id))
    }
    if (ids.length > 0) {
      if (options?.tx) this.written.add(options.tx)
      else this.wake()
    }
    return ids
  }

  /** Asked for, else that of the job whose handler is writing it, else normal. */
  private priorityOf(options?: EnqueueOptions): JobPriority {
    if (options?.priority) return options.priority
    // A job that works through everything outstanding is nobody's in particular
    if (options?.unlessWaiting) return 'normal'
    return this.runningPriority.getStore() ?? 'normal'
  }

  async transaction<T>(db: Database, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    let used: Transaction | undefined
    const result = await db.transaction((tx) => {
      used = tx
      return fn(tx)
    })
    if (used && this.written.has(used)) this.wake()
    return result
  }

  /**
   * A job was written: take it here if this process is a worker, and tell
   * every worker task. Called by `enqueue` and `transaction`, not by hand.
   * Returns at once; a signal that is lost costs only latency, since the jobs
   * are in the database.
   *
   * A worker tells the others too: busy with one job, it would otherwise hold
   * what it just queued until that job ended while another task sat idle.
   */
  wake(): void {
    this.wakeHere()
    this.signal?.request()
  }

  /**
   * Make a pass in this process only — for a signal received (`/wake`) and the
   * worker's own hourly pass. **Never forwards it**: a received signal sent on
   * to every task would come back, and the tasks would signal each other for
   * ever. A pass sends a signal of its own only when a job it runs writes one.
   */
  wakeHere(): void {
    if (this.handlers) this.requestPass()
  }

  async countJobs(): Promise<{ type: string; status: JobStatus; count: number }[]> {
    const status = jobStatus()
    return this.db
      .select({
        type: jobTable.type,
        status,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(jobTable)
      .groupBy(jobTable.type, status)
      .orderBy(jobTable.type)
  }

  async listJobs(options: {
    status?: JobStatus
    type?: string
    limit: number
    offset: number
  }): Promise<{ items: JobRecord[]; total: number }> {
    const where = and(
      options.status ? sql`${jobStatus()} = ${options.status}` : undefined,
      options.type ? eq(jobTable.type, options.type) : undefined
    )
    // The total apart from the page: counted over the page's own rows, a page
    // past the end — the last row on it just retried or deleted — reads 0
    const [items, total] = await Promise.all([
      this.db
        .select({
          id: jobTable.id,
          type: jobTable.type,
          payload: jobTable.payload,
          status: jobStatus(),
          priority: jobTable.priority,
          attempts: jobTable.attempts,
          runAt: jobTable.runAt,
          lastError: jobTable.lastError,
          created: jobTable.created,
          updated: jobTable.updated,
        })
        .from(jobTable)
        .where(where)
        .orderBy(...(options.status === 'waiting' ? takeOrder() : [desc(jobTable.updated)]))
        .limit(options.limit)
        .offset(options.offset),
      this.db.$count(jobTable, where),
    ])
    return { items, total }
  }

  async retryDead(id: string): Promise<boolean> {
    // The last error is kept: it is what the admin retried over, and a job
    // that succeeds is deleted with it
    const rows = await this.db
      .update(jobTable)
      .set({ state: 'ready', attempts: 0, runAt: sql`now()`, updated: sql`now()` })
      .where(and(eq(jobTable.id, id), eq(jobTable.state, 'dead')))
      .returning({ id: jobTable.id })
    if (rows.length > 0) this.wake()
    return rows.length > 0
  }

  async deleteDead(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(jobTable)
      .where(and(eq(jobTable.id, id), eq(jobTable.state, 'dead')))
      .returning({ id: jobTable.id })
    return rows.length > 0
  }

  async pruneDead(olderThanMs: number): Promise<number> {
    const rows = await this.db
      .delete(jobTable)
      .where(
        and(
          eq(jobTable.state, 'dead'),
          lt(jobTable.updated, sql`now() - ${`${olderThanMs} milliseconds`}::interval`)
        )
      )
      .returning({ id: jobTable.id })
    return rows.length
  }

  async process(handlers: Handlers): Promise<void> {
    if (this.handlers) throw new Error('PostgresJobQueue.process() already running')
    this.handlers = handlers
    // What was written while no worker was up — its signals went nowhere
    this.requestPass()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.disarm()
    while (this.pending.size > 0) await Promise.all(this.pending)
  }

  /** Start loops until `concurrency` are taking jobs. */
  private requestPass(): void {
    if (this.stopped) return
    this.wakes++
    // Once per waking from idle, not per loop: every loop would find the same rows
    let bury = this.active === 0
    while (this.active < this.concurrency) {
      this.active++
      const lane: Promise<void> = this.lane(bury).finally(() => this.pending.delete(lane))
      this.pending.add(lane)
      bury = false
    }
  }

  /** Take and run jobs until none is ready, then close as a loop that stopped. */
  private async lane(bury: boolean): Promise<void> {
    let failed = false
    try {
      if (bury) await this.buryExhausted()
      while (!this.stopped) {
        const looked = this.wakes
        const next = await this.claim()
        if (!next) {
          if (this.wakes !== looked) continue
          break
        }
        // The first job since the loops were idle lifts the figure at once, whatever
        // the last count said: read as idle, the policy would scale in under the work
        const first = !this.tookSinceIdle
        this.tookSinceIdle = true
        this.jobStarted()
        try {
          await this.countWaiting(first)
          await this.run(next)
        } finally {
          this.jobEnded()
        }
      }
    } catch (err) {
      failed = true
      this.passFailed(err)
    }
    const last = --this.active === 0
    if (last) this.tookSinceIdle = false
    if (this.stopped || failed) return
    // The last loop reports the idle figure; any other only makes sure a delayed
    // job wakes a loop when it comes due, not when the busy ones finish
    try {
      if (last) await this.countIdle()
      await this.armForNextDue()
    } catch (err) {
      this.passFailed(err)
    }
  }

  /** Try again in a while, and not sooner: armed at once, it would fail again at once. */
  private passFailed(err: unknown): void {
    this.log.error({ err }, 'Job queue pass failed')
    this.backoffUntil = Date.now() + DRAIN_RETRY_MS
    // In place of any sooner timer, which would only fail again
    this.disarm()
    this.arm(DRAIN_RETRY_MS)
  }

  private jobStarted(): void {
    // Counted on through the run: a long job would otherwise leave the figure
    // at what it was when the job was taken, hiding a backlog that built since
    if (this.running++ === 0 && this.onWaiting) {
      this.counting = setInterval(() => void this.countWaiting(true), WAITING_COUNT_MS)
      this.counting.unref?.()
    }
  }

  private jobEnded(): void {
    if (--this.running === 0) clearInterval(this.counting)
  }

  /**
   * What an idle worker reports: the failed jobs waiting out their retry delay,
   * which nobody else speaks for. Not a job another worker holds — that worker
   * reports it — nor one delayed on purpose (a debounce), which is not work yet.
   */
  private async countIdle(): Promise<void> {
    if (!this.onWaiting) return
    await this.report(and(ready(), gt(jobTable.attempts, 0), unleased()), () => this.running === 0)
  }

  /**
   * At most once a minute unless `force`d. Counts what is due, the held jobs
   * among it, and what failed and waits to retry.
   */
  private async countWaiting(force = false): Promise<void> {
    if (!this.onWaiting) return
    if (!force && Date.now() - this.waitingCountedAt < WAITING_COUNT_MS) return
    // Stamped as it starts: two loops taking jobs together would otherwise both
    // find the last stamp old and count twice
    this.waitingCountedAt = Date.now()
    await this.report(
      and(ready(), or(due(), gt(jobTable.attempts, 0))),
      // A count still in flight when the last job ended describes one that is
      // gone; applied, it would replace the idle figure for an hour
      () => this.running > 0
    )
  }

  /**
   * Best-effort: a count that fails is logged and skipped. Thrown, it would end
   * the pass between taking a job and running it, leaving the job leased and
   * idle for the length of the lease.
   */
  private async report(where: SQL | undefined, stillTrue: () => boolean): Promise<void> {
    try {
      const count = await this.db.$count(jobTable, where)
      if (stillTrue()) this.onWaiting!(count)
    } catch (err) {
      this.log.warn({ err }, 'Could not count the waiting jobs')
    }
  }

  /**
   * Leased jobs whose worker stopped answering on their last attempt. Nothing
   * else marks them: the failure path is the worker's, and it is gone.
   */
  private async buryExhausted(): Promise<void> {
    await this.db
      .update(jobTable)
      .set({
        state: 'dead',
        lockedUntil: null,
        lockedBy: null,
        lastError: 'Lease expired on the last attempt',
        updated: sql`now()`,
      })
      .where(
        and(ready(), gte(jobTable.attempts, MAX_ATTEMPTS), lt(jobTable.lockedUntil, sql`now()`))
      )
  }

  private async claim(): Promise<Taken | null> {
    const candidate = this.db
      .select({ id: jobTable.id })
      .from(jobTable)
      .where(and(ready(), due(), lt(jobTable.attempts, MAX_ATTEMPTS), unleased()))
      .orderBy(...takeOrder())
      .limit(1)
      .for('update', { skipLocked: true })
    const [row] = await this.db
      .update(jobTable)
      .set({
        lockedUntil: inSeconds(LEASE_S),
        lockedBy: this.owner,
        attempts: sql`${jobTable.attempts} + 1`,
        updated: sql`now()`,
      })
      // A scalar subquery, not `IN`: evaluated once, so it names one row. Under
      // `IN` the planner may rescan it, and SKIP LOCKED then answers with a
      // different row each time — leasing jobs this worker never runs.
      .where(sql`${jobTable.id} = (${candidate})`)
      .returning({
        id: jobTable.id,
        type: jobTable.type,
        data: jobTable.payload,
        priority: jobTable.priority,
      })
    return row ?? null
  }

  private async run(job: Taken): Promise<void> {
    const handler = this.handlers![job.type]
    if (!handler) {
      this.log.warn({ type: job.type, jobId: job.id }, 'Unknown job type, deleting')
      await this.complete(job.id)
      return
    }
    const holding = this.hold(job.id)
    try {
      await this.runningPriority.run(job.priority, () => handler(job))
      await this.complete(job.id)
    } catch (err) {
      // Only while stopping: thrown at any other time, an uncounted rerun at once
      // would run it again for ever
      if (err instanceof JobInterruptedError && this.stopped) {
        this.log.info({ jobId: job.id, type: job.type }, 'Job cut short by the stop, handed back')
        await this.release(job.id)
      } else {
        // Payload included: some handlers log nothing of their own before
        // throwing, leaving this as the only record of which job it was.
        this.log.error({ err, jobId: job.id, type: job.type, data: job.data }, 'Handler error')
        await this.fail(job.id, err)
      }
    } finally {
      holding.release()
    }
  }

  private async complete(id: string): Promise<void> {
    await this.db.delete(jobTable).where(this.mine(id))
  }

  private async fail(id: string, err: unknown): Promise<void> {
    await this.db
      .update(jobTable)
      .set({
        state: sql`case when ${jobTable.attempts} >= ${MAX_ATTEMPTS} then 'dead' else 'ready' end`,
        runAt: inSeconds(RETRY_DELAY_S),
        lockedUntil: null,
        lockedBy: null,
        lastError: err instanceof Error ? err.message : String(err),
        updated: sql`now()`,
      })
      .where(this.mine(id))
  }

  /**
   * Hand the job back as it was taken, for another worker to run now — told
   * so, or it waits for a pass that may be the lease's end. Told here rather
   * than through `signal`, which this process may exit before it sends.
   */
  private async release(id: string): Promise<void> {
    await this.db
      .update(jobTable)
      .set({
        attempts: sql`${jobTable.attempts} - 1`,
        runAt: sql`now()`,
        lockedUntil: null,
        lockedBy: null,
        updated: sql`now()`,
      })
      .where(this.mine(id))
    await this.notify?.().catch((err: unknown) =>
      this.log.warn({ err }, 'Could not wake the workers for a job handed back')
    )
  }

  private mine(id: string) {
    return and(eq(jobTable.id, id), eq(jobTable.lockedBy, this.owner))
  }

  /**
   * Keep extending this job's lease until the returned handle is released.
   * Failures are logged and not raised: losing the lease lets another worker
   * take the job, which is not a reason to fail the run in progress.
   */
  private hold(id: string): { release: () => void } {
    const until = Date.now() + MAX_HOLD_MS
    const timer = setInterval(() => {
      if (Date.now() > until) {
        clearInterval(timer)
        this.log.warn({ jobId: id }, 'Job has held its lease too long; letting it go')
        return
      }
      this.db
        .update(jobTable)
        .set({ lockedUntil: inSeconds(LEASE_S) })
        .where(this.mine(id))
        .catch((err: unknown) => this.log.warn({ err, jobId: id }, 'Could not extend the lease'))
    }, HOLD_INTERVAL_MS)
    timer.unref?.()
    return { release: () => clearInterval(timer) }
  }

  /**
   * Come back when the earliest job not ready now becomes ready: a delayed one
   * comes due, or a lease runs out. The lease matters after a crash — the job
   * the dead process held is leased to an owner that no longer exists, and
   * nothing else would ask for it before the hourly pass. Whoever holds a live
   * lease keeps extending it, so while one is working this re-arms at each
   * extension; the database is awake for that work anyway.
   */
  private async armForNextDue(): Promise<void> {
    // `greatest` skips a null lease: an unleased row is ready at its `run_at`
    const readyAt = sql`greatest(${jobTable.runAt}, ${jobTable.lockedUntil})`
    const [row] = await this.db
      .select({ inSeconds: sql<string | null>`extract(epoch from min(${readyAt}) - now())` })
      .from(jobTable)
      // Not this process's own jobs: it extends their leases while they run, and
      // takes the next job when each ends
      .where(and(ready(), or(isNull(jobTable.lockedBy), ne(jobTable.lockedBy, this.owner))))
    if (row?.inSeconds != null) this.arm(Math.max(Number(row.inSeconds), 0) * 1000)
  }

  /**
   * Make a pass in `delayMs`, unless one is already due sooner. Several loops
   * ask when the next job is due at once, and the answer that arrives last may
   * be the oldest: taken as it came, it would put back a later time over a job
   * that came due since.
   */
  private arm(delayMs: number): void {
    if (this.stopped) return
    delayMs = Math.max(delayMs, this.backoffUntil - Date.now())
    const at = Date.now() + delayMs
    if (this.timer && this.timerAt <= at) return
    this.disarm()
    this.timerAt = at
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.timerAt = Infinity
      this.requestPass()
    }, delayMs)
    this.timer.unref?.()
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.timerAt = Infinity
  }
}
