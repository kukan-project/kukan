/**
 * KUKAN Resource Pipeline Service
 * Manages pipeline state in resource_pipeline / resource_pipeline_step tables
 */

import { eq, and, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resourcePipeline, resourcePipelineStep } from '@kukan/db'
import { ValidationError, PIPELINE_JOB_TYPE } from '@kukan/shared'
import type { PipelineStatus, PipelineStepStatus, PipelineStepName } from '@kukan/shared'

export class ResourcePipelineService {
  constructor(
    private db: Database,
    private queue?: {
      enqueue<T>(type: string, data: T): Promise<string>
    }
  ) {}

  /**
   * Create or reset a pipeline for a resource and enqueue processing.
   * Returns the queue job ID.
   */
  async enqueue(resourceId: string): Promise<string> {
    if (!this.queue) {
      throw new ValidationError('Queue adapter is required to enqueue pipelines')
    }

    // Upsert pipeline record and delete old steps atomically
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(resourcePipeline)
        .values({
          resourceId,
          status: 'queued',
          error: null,
          previewKey: null,
          metadata: null,
        })
        .onConflictDoUpdate({
          target: resourcePipeline.resourceId,
          set: {
            status: 'queued',
            error: null,
            updated: sql`NOW()`,
          },
        })
        .returning()

      await tx.delete(resourcePipelineStep).where(eq(resourcePipelineStep.pipelineId, row.id))

      return row
    })

    // Enqueue processing job
    const jobId = await this.queue.enqueue(PIPELINE_JOB_TYPE, { resourceId })
    return jobId
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

  /**
   * Start pipeline processing (set status to 'processing').
   */
  async startPipeline(resourceId: string) {
    const [pipeline] = await this.db
      .update(resourcePipeline)
      .set({
        status: 'processing' satisfies PipelineStatus,
        updated: sql`NOW()`,
      })
      .where(
        and(eq(resourcePipeline.resourceId, resourceId), eq(resourcePipeline.status, 'queued'))
      )
      .returning()

    return pipeline
  }

  /**
   * Update pipeline status.
   */
  async updateStatus(pipelineId: string, status: PipelineStatus, error?: string) {
    await this.db
      .update(resourcePipeline)
      .set({
        status,
        error: error ?? null,
        updated: sql`NOW()`,
      })
      .where(eq(resourcePipeline.id, pipelineId))
  }

  /**
   * Update preview key and metadata after extract step.
   */
  async updatePreviewKey(
    pipelineId: string,
    previewKey: string,
    metadata?: Record<string, unknown>
  ) {
    await this.db
      .update(resourcePipeline)
      .set({
        previewKey,
        ...(metadata && { metadata }),
        updated: sql`NOW()`,
      })
      .where(eq(resourcePipeline.id, pipelineId))
  }

  /**
   * Create a step record and mark it as running.
   */
  async startStep(pipelineId: string, stepName: PipelineStepName) {
    const [step] = await this.db
      .insert(resourcePipelineStep)
      .values({
        pipelineId,
        stepName,
        status: 'running' satisfies PipelineStepStatus,
        startedAt: sql`NOW()`,
      })
      .returning()

    return step.id
  }

  /**
   * Mark a step as complete.
   */
  async completeStep(stepId: string) {
    await this.db
      .update(resourcePipelineStep)
      .set({
        status: 'complete' satisfies PipelineStepStatus,
        completedAt: sql`NOW()`,
      })
      .where(eq(resourcePipelineStep.id, stepId))
  }

  /**
   * Mark a step as failed.
   */
  async failStep(stepId: string, error: string) {
    await this.db
      .update(resourcePipelineStep)
      .set({
        status: 'error' satisfies PipelineStepStatus,
        error,
        completedAt: sql`NOW()`,
      })
      .where(eq(resourcePipelineStep.id, stepId))
  }

  /**
   * Mark a step as skipped.
   */
  async skipStep(stepId: string) {
    await this.db
      .update(resourcePipelineStep)
      .set({
        status: 'skipped' satisfies PipelineStepStatus,
        completedAt: sql`NOW()`,
      })
      .where(eq(resourcePipelineStep.id, stepId))
  }
}
