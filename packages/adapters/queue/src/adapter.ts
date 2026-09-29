/**
 * KUKAN Queue Adapter Interface
 * Job queue backend (PostgreSQL, ADR-058)
 */

import type { Database, Transaction } from '@kukan/db'
import type { JobPriority, JobStatus } from '@kukan/shared'

export interface Job<T = unknown> {
  id: string
  type: string
  data: T
}

/** One job as the admin screen lists it. */
export interface JobRecord {
  id: string
  type: string
  payload: unknown
  status: JobStatus
  priority: JobPriority
  attempts: number
  runAt: Date
  lastError: string | null
  created: Date
  updated: Date
}

export interface EnqueueOptions {
  /** Hold the job back by this many seconds */
  delaySeconds?: number
  /**
   * Who waits for the result (ADR-058 §6). Unset: the running handler's job's,
   * else `normal` — and always `normal` with `unlessWaiting`.
   */
  priority?: JobPriority
  /**
   * Write the job inside this transaction, so it exists only if the rest of
   * the transaction commits. Nothing is woken until then — the job is not
   * there to be seen — so open it with `transaction()`, which wakes after the
   * commit.
   */
  tx?: Transaction
  /**
   * Write nothing when a job of this type and payload is waiting that no
   * worker has ever taken, due no later than this one would be; raise it to
   * this one's priority, and return its id. For a job that works through
   * whatever is outstanding when it runs (a sync, a rebuild): the waiting one
   * will see what the caller just wrote. One a worker holds does not count —
   * it may already have looked — and neither does one waiting to be retried,
   * which may be minutes away or never run again, nor one delayed past
   * `delaySeconds`: it would hold the work back to its time.
   *
   * Not with `tx` for the write the job is to see: the waiting job can run
   * before that transaction commits and miss it. Enqueue after the commit.
   */
  unlessWaiting?: boolean
}

export interface QueueAdapter {
  /**
   * Enqueue a new job, and wake the worker unless a transaction was given
   */
  enqueue<T>(type: string, data: T, options?: EnqueueOptions): Promise<string>

  /**
   * Enqueue one job per item, in as few statements as the database allows.
   * For a caller holding row locks in `options.tx`: one round trip per job
   * would hold them for as long as the list is.
   */
  enqueueMany<T>(type: string, data: T[], options?: EnqueueOptions): Promise<string[]>

  /**
   * Run `fn` in a transaction on `db`, and wake the worker after the commit if
   * a job was written in it. Pass the top-level handle: a nested transaction
   * is a savepoint, and waking at its release is waking before the commit.
   */
  transaction<T>(db: Database, fn: (tx: Transaction) => Promise<T>): Promise<T>

  /**
   * How many jobs of each type stand in each status; only the pairs that
   * have any
   */
  countJobs(): Promise<{ type: string; status: JobStatus; count: number }[]>

  /**
   * List jobs, optionally of one status and one type: waiting ones in the
   * order they will be taken, the rest newest change first
   */
  listJobs(options: {
    status?: JobStatus
    type?: string
    limit: number
    offset: number
  }): Promise<{ items: JobRecord[]; total: number }>

  /**
   * Put a dead job back to be taken now, with its attempts reset.
   * False when there is no such dead job.
   */
  retryDead(id: string): Promise<boolean>

  /**
   * Delete a dead job. False when there is no such dead job.
   */
  deleteDead(id: string): Promise<boolean>

  /**
   * Delete the dead jobs that have not changed for this long. Returns how many.
   */
  pruneDead(olderThanMs: number): Promise<number>

  /**
   * Start processing jobs. Dispatches each job to the handler matching its type.
   * Jobs with unknown types are logged and deleted.
   */
  process(handlers: Record<string, (job: Job<unknown>) => Promise<void>>): Promise<void>

  /**
   * Stop processing jobs
   */
  stop(): Promise<void>
}
