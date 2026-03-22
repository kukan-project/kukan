/**
 * KUKAN Queue Adapter Interface
 * SQS-compatible job queue backend (AWS SQS / ElasticMQ)
 */

export interface Job<T = unknown> {
  id: string
  type: string
  data: T
}

export type JobState = 'pending' | 'processing' | 'completed' | 'failed'

export interface JobStatus {
  id: string
  status: JobState
  error?: string
}

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
