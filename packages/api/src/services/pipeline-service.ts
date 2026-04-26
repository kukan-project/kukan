/**
 * KUKAN Pipeline Service (API-side)
 * Handles enqueue and status queries — Worker-side execution is separate.
 */

import { eq, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource, resourcePipeline, resourcePipelineStep } from '@kukan/db'
import { ValidationError, PIPELINE_JOB_TYPE } from '@kukan/shared'
import type { PipelineStatus } from '@kukan/shared'
import type { QueueAdapter } from '@kukan/queue-adapter'

export class PipelineService {
  constructor(
    private db: Database,
    private queue?: QueueAdapter
  ) {}

  /**
   * Create or reset a pipeline for a resource and enqueue processing.
   * Returns the queue job ID.
   */
  async enqueue(resourceId: string): Promise<string> {
    if (!this.queue) {
      throw new ValidationError('Queue adapter is required to enqueue pipelines')
    }

    // Upsert pipeline record — preserve existing previewKey/metadata until Worker starts
    const [pipeline] = await this.db
      .insert(resourcePipeline)
      .values({
        resourceId,
        status: 'queued' satisfies PipelineStatus,
        error: null,
        previewKey: null,
        metadata: null,
      })
      .onConflictDoUpdate({
        target: resourcePipeline.resourceId,
        set: {
          status: 'queued' satisfies PipelineStatus,
          error: null,
          updated: sql`NOW()`,
        },
      })
      .returning()

    // Enqueue processing job — rollback DB status on failure
    try {
      const jobId = await this.queue.enqueue(PIPELINE_JOB_TYPE, { resourceId })
      return jobId
    } catch (err) {
      await this.db
        .update(resourcePipeline)
        .set({
          status: 'error' satisfies PipelineStatus,
          error: `Queue enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
          updated: sql`NOW()`,
        })
        .where(eq(resourcePipeline.id, pipeline.id))
      throw err
    }
  }

  /**
   * Enqueue pipeline processing for all active resources.
   * Individual enqueue failures are counted but do not stop the batch.
   */
  async enqueueAll(): Promise<{ enqueued: number; failed: number }> {
    const resources = await this.db
      .select({ id: resource.id })
      .from(resource)
      .where(eq(resource.state, 'active'))

    const BATCH_SIZE = 100
    let enqueued = 0
    let failed = 0
    for (let i = 0; i < resources.length; i += BATCH_SIZE) {
      const batch = resources.slice(i, i + BATCH_SIZE)
      const results = await Promise.allSettled(batch.map((r) => this.enqueue(r.id)))
      for (const r of results) {
        if (r.status === 'fulfilled') enqueued++
        else failed++
      }
    }
    return { enqueued, failed }
  }

  /**
   * Get pipeline status with steps for a resource.
   */
  async getStatus(resourceId: string) {
    const [pipeline] = await this.db
      .select()
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, resourceId))
      .limit(1)

    if (!pipeline) {
      return null
    }

    const steps = await this.db
      .select()
      .from(resourcePipelineStep)
      .where(eq(resourcePipelineStep.pipelineId, pipeline.id))
      .orderBy(resourcePipelineStep.startedAt)

    return { ...pipeline, steps }
  }
}
