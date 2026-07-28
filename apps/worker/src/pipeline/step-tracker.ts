/**
 * KUKAN Pipeline Step Tracker (Worker-side)
 * Manages pipeline state in resource_pipeline / resource_pipeline_step tables
 * during pipeline execution.
 */

import { eq, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resourcePipeline, resourcePipelineStep } from '@kukan/db'
import type { PipelineStatus, PipelineStepStatus, PipelineStepName } from '@kukan/shared'
import {
  claimPipeline,
  pipelineClaimHolder,
  releasePipelineClaim,
} from '@kukan/api/services/pipeline-claim'
import { randomUUID } from 'node:crypto'
import { CLAIM_STALE_AFTER_MS } from '@/config'

export class StepTracker {
  constructor(private db: Database) {}

  /**
   * The run this tracker speaks for. Minted here because the tracker is built
   * once per run, so nothing else has to carry it around.
   */
  private readonly owner = randomUUID()

  /**
   * Claim the resource for this run, and clear the previous run's steps.
   *
   * The rules live with the other database invariants (ADR-044); this is the
   * pipeline's entry point into them. Returns null when another run holds it —
   * which is not a failure.
   */
  async startPipeline(resourceId: string) {
    return claimPipeline(this.db, resourceId, this.owner, CLAIM_STALE_AFTER_MS)
  }

  /** Whether anyone holds the resource, to tell "busy" from "no such row". */
  async claimHolder(resourceId: string) {
    return pipelineClaimHolder(this.db, resourceId)
  }

  /** Give the claim up. No-op unless this run still holds it. */
  async releaseClaim(pipelineId: string) {
    await releasePipelineClaim(this.db, pipelineId, this.owner)
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
