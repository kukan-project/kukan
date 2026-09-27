/**
 * KUKAN Queue Adapter Interface
 * Job queue backend (PostgreSQL, ADR-058)
 */

import type { Database, Transaction } from '@kukan/db'

export interface Job<T = unknown> {
  id: string
  type: string
  data: T
}

export interface QueueStats {
  /** Jobs ready to be taken now */
  pending: number
  /** Jobs a worker holds */
  inFlight: number
  /** Jobs waiting out a delay or a retry */
  delayed: number
  /** Jobs that failed every attempt and are no longer taken */
  dead: number
}

export interface EnqueueOptions {
  /** Hold the job back by this many seconds */
  delaySeconds?: number
  /**
   * Write the job inside this transaction, so it exists only if the rest of
   * the transaction commits. Nothing is woken until then — the job is not
   * there to be seen — so open it with `transaction()`, which wakes after the
   * commit.
   */
  tx?: Transaction
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
   * Get queue statistics (job counts)
   */
  getStats(): Promise<QueueStats>

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
