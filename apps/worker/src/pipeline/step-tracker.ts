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
   * Take the row over for this run: mark it running and drop the steps of
   * whatever ran last, so the record describes this run alone.
   *
   * Safe as a write of its own only because the caller holds the claim
   * (ADR-044) — no other run can be recording steps against this row.
   */
  async beginRun(pipelineId: string) {
    await this.db.execute(sql`
      WITH cleared AS (
        DELETE FROM resource_pipeline_step WHERE pipeline_id = ${pipelineId}::uuid
      )
      UPDATE resource_pipeline
      SET status = 'processing', error = NULL, updated = NOW()
      WHERE id = ${pipelineId}::uuid
    `)
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
   * the objects that leaves behind (ADR-043).
   *
   * Two of them: the preview this run replaces, and the previous run's text
   * head — the metadata is replaced wholesale rather than merged, so its
   * pointer goes with it and nothing else would ever park that object.
   *
   * One statement, because the keys being parked are whatever the row holds
   * *now*, not what this run read at startup, which a concurrent run of the
   * same resource may already have moved past. Deletion is the sweep's job.
   */
  async updateExtractResult(
    pipelineId: string,
    previewKey: string | null,
    metadata: Record<string, unknown>
  ) {
    await this.db.execute(sql`
      WITH before AS (
        SELECT id, preview_key, metadata ->> 'textHeadKey' AS text_head
        FROM resource_pipeline WHERE id = ${pipelineId}::uuid FOR UPDATE
      ),
      moved AS (
        UPDATE resource_pipeline p
        SET preview_key = ${previewKey}::text,
            metadata = ${JSON.stringify(metadata)}::jsonb,
            updated = NOW()
        FROM before b
        WHERE p.id = b.id
        RETURNING b.preview_key AS previous_preview, b.text_head AS previous_text_head
      )
      INSERT INTO orphaned_object (key)
      SELECT key FROM moved, LATERAL (VALUES (previous_preview), (previous_text_head)) v(key)
      WHERE key IS NOT NULL
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
