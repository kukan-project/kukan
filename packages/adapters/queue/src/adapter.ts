/**
 * KUKAN Queue Adapter Interface
 * Pluggable job queue backend (SQS or in-process)
 */

import { Job, JobStatus } from '@kukan/shared'

export interface QueueAdapter {
  /**
   * Enqueue a new job
   */
  enqueue<T>(type: string, data: T): Promise<string>

  /**
   * Get job status
   */
  getStatus(jobId: string): Promise<JobStatus | null>

  /**
   * Start processing jobs with a handler function
   */
  process<T>(type: string, handler: (job: Job<T>) => Promise<void>): Promise<void>

  /**
   * Stop processing jobs
   */
  stop(): Promise<void>
}
