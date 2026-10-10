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

import { sql, type SQL } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { pipelineObjectKeys, resourcePipeline, schemaColumnNames } from '@kukan/db'
import type {
  PipelineStatus,
  PipelineStepStatus,
  PipelineStepName,
  TableProfile,
} from '@kukan/shared'
import { heldBy, type ResourceClaim } from '@kukan/api/services/pipeline/pipeline-claim'
import { PARKED_UNTIL } from '@kukan/api/services/pipeline/storage-pointer'

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
    /** The run's identity, and what the steps read to write under it. */
    readonly claim: ResourceClaim
  ) {}

  /**
   * The steps this run has started and not settled, outermost first.
   *
   * Held here rather than passed back through the orchestrator because the
   * caller that needs it is the one that does not have it: a step whose failure
   * ends the run is abandoned where it stands, and the `catch` that records the
   * run as failed is several frames above whatever id was in scope.
   *
   * A stack rather than a slot because steps nest — the Lake step is started
   * from inside the interpretation, while the Interpret step is still open. One
   * slot would have been taken by Lake and cleared when Lake settled, leaving
   * the enclosing step forgotten while it was still running: the very state
   * this exists to prevent, reappearing the moment Interpret is made fatal.
   */
  private openSteps: string[] = []

  /** SQL condition: this row, and this run still holds it. */
  private get held() {
    return heldBy(this.claim)
  }

  /**
   * Take the row over for this run: mark it running and drop the steps of
   * whatever ran last, so the record describes this run alone.
   *
   * The delete hangs off the update rather than standing beside it. A
   * data-modifying CTE runs whether or not the primary statement matches
   * anything, so written the other way round a run that had already been
   * displaced would clear the steps of the run that displaced it.
   */
  async beginRun() {
    this.openSteps = []
    await this.db.execute(sql`
      WITH taken AS (
        UPDATE resource_pipeline
        SET status = 'processing', error = NULL, updated = NOW()
        WHERE ${this.held}
        RETURNING id
      )
      DELETE FROM resource_pipeline_step s USING taken WHERE s.pipeline_id = taken.id
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
   * Move the preview pointer and replace the metadata and the table profile
   * describing it (ADR-063), parking the objects that leaves behind (ADR-043).
   *
   * The pointers the previous run kept in the metadata go too: it is replaced
   * wholesale rather than merged, so they go with it and nothing else would
   * ever park their objects.
   */
  async updateInterpretResult(
    previewKey: string | null,
    metadata: Record<string, unknown>,
    profile: TableProfile | null
  ) {
    await this.movePointers(sql`
      preview_key = ${previewKey}::text,
      metadata = ${JSON.stringify(metadata)}::jsonb,
      profile = ${profile ? JSON.stringify(profile) : null}::jsonb`)
  }

  /**
   * Merge into the pipeline's metadata, parking the objects whose pointers the
   * merge replaces. Reached when the interpretation threw and so left the
   * previous metadata in place; one that succeeded has already parked them.
   */
  async mergeMetadata(metadata: Record<string, unknown>) {
    await this.movePointers(
      sql`metadata = COALESCE(p.metadata, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb`
    )
  }

  /**
   * Rewrite the row with `set`, parking every object it named before and does
   * not name after, and settling the write-ahead record of every object it
   * names now (ADR-045).
   *
   * One statement, because the keys being parked are whatever the row holds
   * *now*, not what this run read at startup. Deletion is the sweep's job. The
   * keys are the one list of them (`pipelineObjectKeys`), so a pointer added
   * there is parked here without another word.
   *
   * The table's column names are in the resource's search document (ADR-063
   * §決定 7), so a rewrite that changes them marks it, in the same statement:
   * a sync between a mark and the write would clear it over the old names.
   */
  private async movePointers(set: SQL) {
    await this.db.execute(sql`
      WITH before AS (
        SELECT id, resource_id, ARRAY[${sql.join(pipelineObjectKeys('r'), sql`, `)}] AS keys,
               ${schemaColumnNames(sql`r.metadata`)} AS columns
        FROM resource_pipeline r WHERE ${this.held} FOR UPDATE
      ),
      moved AS (
        UPDATE resource_pipeline p
        SET ${set}, updated = NOW()
        FROM before b
        WHERE p.id = b.id
        RETURNING b.keys AS previous,
                  array_remove(ARRAY[${sql.join(pipelineObjectKeys('p'), sql`, `)}], NULL) AS current,
                  b.resource_id,
                  b.columns IS DISTINCT FROM ${schemaColumnNames(sql`p.metadata`)} AS renamed
      ),
      marked AS (
        UPDATE resource SET doc_sync_due_at = NOW()
        FROM moved WHERE resource.id = moved.resource_id AND moved.renamed
      ),
      parked AS (
        INSERT INTO orphaned_object (key, expires_at)
        SELECT key, ${PARKED_UNTIL}
        FROM moved, unnest(moved.previous) AS key
        WHERE key IS NOT NULL AND key <> ALL (moved.current)
        ON CONFLICT (key) DO NOTHING
      )
      -- Referenced now, so their write-ahead records are done. Taken from moved
      -- so a run that lost the claim does not drop the record of an object its
      -- own row never came to reference.
      DELETE FROM orphaned_object o USING moved WHERE o.key = ANY (moved.current)
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
    this.openSteps.push(step.id)
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
    // After the write, not before: a settle that throws — a lock timeout, a
    // reset connection — has to leave the step open, or the run's own handler
    // finds nothing to record and the row reads `error` over a step that reads
    // `running`. That is the state this file exists to stop.
    //
    // A write that matched nothing is a different case and needs no undo here:
    // it means the claim is gone, and the retry below is blocked by the same
    // condition.
    this.openSteps = this.openSteps.filter((id) => id !== stepId)
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

  /**
   * Record whatever step is still running as the one that failed.
   *
   * Every step but Fetch settles its own failure and lets the run continue; a
   * Fetch that throws ends the run, and until this existed it ended it without
   * closing its own row. The pipeline then read `error` while its step read
   * `running`, and the UI — which shows the step — reported a failed resource as
   * in progress, indefinitely. Every one of the 51 failed rows in the
   * development database was in that state, so this was the ordinary outcome of
   * failing rather than an edge case.
   *
   * Nothing open is the normal case for the steps that settle themselves, and
   * this says nothing then.
   */
  async failOpenStep(error: string) {
    // Innermost first, and over a copy: `failStep` settles, which removes.
    for (const stepId of [...this.openSteps].reverse()) {
      await this.failStep(stepId, error)
    }
  }
}
