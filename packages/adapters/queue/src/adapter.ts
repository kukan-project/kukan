/**
 * KUKAN Queue Adapter Interface
 * SQS-compatible job queue backend (AWS SQS / ElasticMQ)
 */

export interface Job<T = unknown> {
  id: string
  type: string
  data: T
}

export interface QueueStats {
  /** Approximate number of messages waiting in the queue */
  pending: number
  /** Approximate number of messages currently being processed */
  inFlight: number
  /** Approximate number of delayed messages */
  delayed: number
}

export interface EnqueueOptions {
  /** Delay delivery of the message by this many seconds (0–900 for SQS) */
  delaySeconds?: number
}

export interface QueueAdapter {
  /**
   * Enqueue a new job
   */
  enqueue<T>(type: string, data: T, options?: EnqueueOptions): Promise<string>

  /**
   * Get queue statistics (message counts)
   */
  getStats(): Promise<QueueStats>

  /**
   * Start processing jobs. Dispatches each message to the handler matching its type.
   * Messages with unknown types are logged and deleted.
   */
  process(handlers: Record<string, (job: Job<unknown>) => Promise<void>>): Promise<void>

  /**
   * Stop processing jobs
   */
  stop(): Promise<void>
}
