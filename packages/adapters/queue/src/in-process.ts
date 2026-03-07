/**
 * KUKAN In-Process Queue Adapter
 * In-memory job queue for development and on-premise deployments
 */

import { randomUUID } from 'crypto'
import { Job, JobStatus, JobState } from '@kukan/shared'
import { QueueAdapter } from './adapter'

interface StoredJob<T = unknown> {
  id: string
  type: string
  data: T
  status: JobState
  createdAt: Date
  updatedAt: Date
  error?: string
}

export class InProcessQueueAdapter implements QueueAdapter {
  private jobs: Map<string, StoredJob> = new Map()
  private handlers: Map<string, (job: Job<unknown>) => Promise<void>> = new Map()
  private running = false
  private processingInterval?: NodeJS.Timeout

  async enqueue<T>(type: string, data: T): Promise<string> {
    const id = randomUUID()
    const now = new Date()

    const job: StoredJob<T> = {
      id,
      type,
      data,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    }

    this.jobs.set(id, job)

    // Trigger immediate processing if handler is registered
    if (this.running && this.handlers.has(type)) {
      void this.processJob(job)
    }

    return id
  }

  async getStatus(jobId: string): Promise<JobStatus | null> {
    const job = this.jobs.get(jobId)
    if (!job) {
      return null
    }
    return {
      id: job.id,
      status: job.status,
      error: job.error,
    }
  }

  async process<T>(type: string, handler: (job: Job<T>) => Promise<void>): Promise<void> {
    this.handlers.set(type, handler as (job: Job<unknown>) => Promise<void>)

    if (!this.running) {
      this.running = true
      this.processingInterval = setInterval(() => {
        void this.processPendingJobs()
      }, 1000) // Process every second
    }
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.processingInterval) {
      clearInterval(this.processingInterval)
      this.processingInterval = undefined
    }
  }

  private async processPendingJobs(): Promise<void> {
    const pendingJobs = Array.from(this.jobs.values()).filter((job) => job.status === 'pending')

    for (const job of pendingJobs) {
      void this.processJob(job)
    }
  }

  private async processJob(storedJob: StoredJob): Promise<void> {
    const handler = this.handlers.get(storedJob.type)
    if (!handler) {
      return
    }

    // Update status to processing
    storedJob.status = 'processing'
    storedJob.updatedAt = new Date()

    const job: Job<unknown> = {
      id: storedJob.id,
      type: storedJob.type,
      data: storedJob.data,
    }

    try {
      await handler(job)
      storedJob.status = 'completed'
    } catch (error) {
      storedJob.status = 'failed'
      storedJob.error = error instanceof Error ? error.message : 'Unknown error'
    } finally {
      storedJob.updatedAt = new Date()
    }
  }
}
