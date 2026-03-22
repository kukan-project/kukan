/**
 * KUKAN Pipeline Service (API-side)
 * Handles enqueue and status queries — Worker-side execution is separate.
 */

import { eq, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resourcePipeline, resourcePipelineStep } from '@kukan/db'
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
