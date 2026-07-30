/**
 * KUKAN Pipeline Step Tracker (Worker-side)
 * Manages pipeline state in resource_pipeline / resource_pipeline_step tables
 * during pipeline execution.
 *
 * Every write here is conditioned on this run still holding the resource's
 * claim (ADR-044 §4). That is what makes a run killable: releasing the claim
 * is the kill, and from that moment the run's writes land on nothing. It is
 * also why the tracker is built per run rather than per worker — the owner is
 * the run's identity, and no call site should have to carry it.
 */

import { sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resourcePipeline } from '@kukan/db'
import type { PipelineStatus, PipelineStepStatus, PipelineStepName } from '@kukan/shared'
import { heldBy, type ResourceClaim } from '@kukan/api/services/pipeline-claim'
import { PARKED_UNTIL } from '@kukan/api/services/storage-pointer'

/**
 * The run no longer holds its resource: something killed it, or took it over
 * for having stalled. Thrown rather than returned so it cannot be ignored at a
 * call site, and caught by the orchestrator, which leaves without recording
 * anything — the record belongs to whoever holds the claim now.
 */
export class RunCancelledError extends Error {
  constructor(resourceId: string) {
    super(`Run for resource ${resourceId} no longer holds the claim`)
    this.name = 'RunCancelledError'
  }
}

export class StepTracker {
  constructor(
    private db: Database,
    private claim: ResourceClaim
  ) {}

  /** SQL condition: this row, and this run still holds it. */
  private get held() {
    return heldBy(this.claim)
  }

  /**
   * Take the row over for this run: mark it running and drop the steps of
   * whatever ran last, so the record describes this run alone.
   *
   * Safe as a write of its own only because the caller holds the claim —
   * no other run can be recording steps against this row.
   */
  async beginRun() {
    await this.db.execute(sql`
      WITH cleared AS (
        DELETE FROM resource_pipeline_step WHERE pipeline_id = ${this.claim.id}::uuid
      )
      UPDATE resource_pipeline
      SET status = 'processing', error = NULL, updated = NOW()
      WHERE ${this.held}
    `)
  }

  /**
   * Update pipeline status. A run that has been killed leaves its status alone
   * — `cancelled` is the record of what happened, and this run is not the one
   * describing the resource any more.
   */
  async updateStatus(status: PipelineStatus, error?: string) {
    await this.db
      .update(resourcePipeline)
      .set({ status, error: error ?? null, updated: sql`NOW()` })
      .where(this.held)
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
   * *now*, not what this run read at startup. Deletion is the sweep's job.
   */
  async updateExtractResult(previewKey: string | null, metadata: Record<string, unknown>) {
    await this.db.execute(sql`
      WITH before AS (
        SELECT id, preview_key, metadata ->> 'textHeadKey' AS text_head
        FROM resource_pipeline WHERE ${this.held} FOR UPDATE
      ),
      moved AS (
        UPDATE resource_pipeline p
        SET preview_key = ${previewKey}::text,
            metadata = ${JSON.stringify(metadata)}::jsonb,
            updated = NOW()
        FROM before b
        WHERE p.id = b.id
        RETURNING b.preview_key AS previous_preview, b.text_head AS previous_text_head
      ),
      parked AS (
        INSERT INTO orphaned_object (key, expires_at)
        SELECT key, ${PARKED_UNTIL}
        FROM moved, LATERAL (VALUES (previous_preview), (previous_text_head)) v(key)
        WHERE key IS NOT NULL
        ON CONFLICT (key) DO NOTHING
      )
      -- The preview is referenced now, so its write-ahead record is done. Taken
      -- from moved so a run that lost the claim does not drop the record of a
      -- preview its own row never came to reference (ADR-045).
      DELETE FROM orphaned_object o USING moved WHERE o.key = ${previewKey}::text
    `)
  }

  /**
   * Merge into the pipeline's metadata, parking the text head the merge
   * replaces — the one pointer that lives inside metadata rather than in a
   * column of its own (ADR-043). Reached when Extract threw and so left the
   * previous metadata in place; a successful Extract has already parked it.
   */
  async mergeMetadata(metadata: Record<string, unknown>) {
    await this.db.execute(sql`
      WITH before AS (
        SELECT id, metadata ->> 'textHeadKey' AS text_head
        FROM resource_pipeline WHERE ${this.held} FOR UPDATE
      ),
      merged AS (
        UPDATE resource_pipeline p
        SET metadata = COALESCE(p.metadata, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb,
            updated = NOW()
        FROM before b
        WHERE p.id = b.id
        RETURNING b.text_head AS previous_key, p.metadata ->> 'textHeadKey' AS new_key
      ),
      parked AS (
        INSERT INTO orphaned_object (key, expires_at)
        SELECT previous_key, ${PARKED_UNTIL} FROM merged
        WHERE previous_key IS NOT NULL AND previous_key IS DISTINCT FROM new_key
        ON CONFLICT (key) DO NOTHING
      )
      -- The text head this merge names is referenced now.
      DELETE FROM orphaned_object o USING merged WHERE o.key = merged.new_key
    `)
  }

  /**
   * Create a step record and mark it as running.
   *
   * The one place the run checks whether it still holds the resource. Every
   * step opens with it, so a kill takes effect at the next boundary rather than
   * mid-step — which is as fine-grained as it can be without a way to interrupt
   * a read in progress, and enough to stop the work that follows.
   *
   * @throws RunCancelledError when the claim is gone.
   */
  async startStep(stepName: PipelineStepName) {
    const result = await this.db.execute(sql`
      INSERT INTO resource_pipeline_step (pipeline_id, step_name, status, started_at)
      SELECT ${this.claim.id}::uuid, ${stepName}, 'running', NOW()
      FROM resource_pipeline WHERE ${this.held}
      RETURNING id
    `)
    const step = result.rows[0] as { id: string } | undefined
    if (!step) throw new RunCancelledError(this.claim.resourceId)
    return step.id
  }

  /**
   * Settle a step, on the same condition as everything else this run writes.
   *
   * Reached through the step's id rather than the pipeline's, so the ownership
   * check joins back — without it a run killed mid-step could still mark that
   * step complete under a pipeline the killer already recorded as cancelled,
   * which is exactly the half-done state §4 wants shown honestly.
   */
  private async settleStep(stepId: string, status: PipelineStepStatus, error?: string) {
    await this.db.execute(sql`
      UPDATE resource_pipeline_step s
      SET status = ${status}, error = ${error ?? null}, completed_at = NOW()
      FROM resource_pipeline p
      WHERE s.id = ${stepId}::uuid AND s.pipeline_id = p.id AND ${heldBy(this.claim, 'p')}
    `)
  }

  /** Mark a step as complete. */
  async completeStep(stepId: string) {
    await this.settleStep(stepId, 'complete')
  }

  /** Mark a step as failed. */
  async failStep(stepId: string, error: string) {
    await this.settleStep(stepId, 'error', error)
  }

  /** Mark a step as skipped. */
  async skipStep(stepId: string) {
    await this.settleStep(stepId, 'skipped')
  }
}
