/**
 * KUKAN Pipeline Step Tracker (Worker-side)
 * Manages pipeline state in resource_pipeline / resource_pipeline_step tables
 * during pipeline execution.
 */

import { eq, and, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resourcePipeline, resourcePipelineStep } from '@kukan/db'
import type { PipelineStatus, PipelineStepStatus, PipelineStepName } from '@kukan/shared'

export class StepTracker {
  constructor(private db: Database) {}

  /**
   * Start pipeline processing: transition to 'processing' and delete old steps.
   * previewKey/metadata are preserved here — they are overwritten by
   * updateExtractResult on success, and kept as-is on failure so the
   * previous preview remains available.
   */
  async startPipeline(resourceId: string) {
    return this.db.transaction(async (tx) => {
      const [pipeline] = await tx
        .update(resourcePipeline)
        .set({
          status: 'processing' satisfies PipelineStatus,
          updated: sql`NOW()`,
        })
        .where(
          and(eq(resourcePipeline.resourceId, resourceId), eq(resourcePipeline.status, 'queued'))
        )
        .returning()

      if (pipeline) {
        await tx
          .delete(resourcePipelineStep)
          .where(eq(resourcePipelineStep.pipelineId, pipeline.id))
      }

      return pipeline
    })
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
   * Update preview key and/or metadata after extract step.
   */
  async updateExtractResult(
    pipelineId: string,
    previewKey: string | null,
    metadata?: Record<string, unknown>
  ) {
    await this.db
      .update(resourcePipeline)
      .set({
        previewKey,
        ...(metadata !== undefined && { metadata }),
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
