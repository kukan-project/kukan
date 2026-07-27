/**
 * KUKAN Pipeline Step Tracker (Worker-side)
 * Manages pipeline state in resource_pipeline / resource_pipeline_step tables
 * during pipeline execution.
 */

import { eq, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resourcePipeline, resourcePipelineStep } from '@kukan/db'
import type { PipelineStatus, PipelineStepStatus, PipelineStepName } from '@kukan/shared'

export class StepTracker {
  constructor(private db: Database) {}

  /**
   * Start pipeline processing: transition to 'processing' and delete old steps.
   * Accepts any current status — SQS visibility timeout guarantees single-consumer
   * delivery, so we don't need a status='queued' guard. This allows recovery from
   * stuck 'processing' pipelines (e.g. worker crash during deployment).
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
          error: null,
          updated: sql`NOW()`,
        })
        .where(eq(resourcePipeline.resourceId, resourceId))
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
   * Move the preview pointer and replace the metadata describing it, parking
   * the key it replaced for later deletion (ADR-043).
   *
   * One statement, because the key being parked is whatever `preview_key` is
   * *now* — not what this run read at startup, which a concurrent run of the
   * same resource may already have moved past. Splitting the two would let one
   * write undo the other. Deletion is the sweep's job.
   */
  async updateExtractResult(
    pipelineId: string,
    previewKey: string | null,
    metadata: Record<string, unknown>
  ) {
    await this.db.execute(sql`
      WITH before AS (
        SELECT id, preview_key FROM resource_pipeline WHERE id = ${pipelineId}::uuid FOR UPDATE
      ),
      moved AS (
        UPDATE resource_pipeline p
        SET preview_key = ${previewKey}::text,
            metadata = ${JSON.stringify(metadata)}::jsonb,
            updated = NOW()
        FROM before b
        WHERE p.id = b.id
        RETURNING b.preview_key AS previous_key
      )
      INSERT INTO orphaned_object (key)
      SELECT previous_key FROM moved
      WHERE previous_key IS NOT NULL
      ON CONFLICT (key) DO NOTHING
    `)
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
