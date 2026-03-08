/**
 * KUKAN SQS Queue Adapter
 * AWS SQS implementation (Phase 3)
 */

import { Job, JobStatus } from '@kukan/shared'
import { QueueAdapter } from './adapter'

export interface SQSConfig {
  region: string
  queueUrl: string
  accessKeyId?: string
  secretAccessKey?: string
}

export class SQSQueueAdapter implements QueueAdapter {
  constructor(_config: SQSConfig) {
    // Stub implementation
  }

  async enqueue<T>(_type: string, _data: T): Promise<string> {
    throw new Error('SQSQueueAdapter not implemented yet (Phase 3)')
  }

  async getStatus(_jobId: string): Promise<JobStatus | null> {
    throw new Error('SQSQueueAdapter not implemented yet (Phase 3)')
  }

  async process<T>(_type: string, _handler: (job: Job<T>) => Promise<void>): Promise<void> {
    throw new Error('SQSQueueAdapter not implemented yet (Phase 3)')
  }

  async stop(): Promise<void> {
    throw new Error('SQSQueueAdapter not implemented yet (Phase 3)')
  }
}
