/**
 * The per-resource execution claim (ADR-044).
 *
 * One resource, one run. SQS delivers at least once and redelivers to a second
 * worker while the first is still going, so two runs do reach the same resource
 * — the claim is what stops the second from starting, rather than each write
 * along the way having to notice it lost.
 *
 * Here rather than in the worker because it is a database invariant, like the
 * storage pointer and the advisory locks: the row is the claim, and the rules
 * for taking it have to hold whoever asks.
 */
import { sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'

/**
 * Take the resource for this run, clearing the previous run's steps.
 *
 * Returns the pipeline id, or null when another run holds it — or when the
 * resource has no pipeline row at all.
 *
 * Takeable again once nothing has progressed for `staleAfterMs`, which is what
 * lets a worker that died mid-run (OOM, task replacement, deploy) be recovered
 * from without anyone intervening.
 *
 * Progress is when the claim was taken or a step last started — never
 * `updated`. That column is written by `PipelineService.enqueue` and by the
 * purge's preview invalidation, neither of which holds the claim, so judging by
 * it would let a user re-uploading keep a dead run's window open indefinitely.
 * Step starts are needed alongside the claim time because a long run must not
 * be taken from: between the end of Extract and the final write, nothing else
 * moves.
 *
 * Conditioned on the row's own columns rather than on a value read first, so
 * the check and the take cannot come apart without a lock to hold them
 * together.
 */
export async function claimPipeline(
  db: Database,
  resourceId: string,
  owner: string,
  staleAfterMs: number
): Promise<{ id: string } | null> {
  const result = await db.execute(sql`
    WITH claimed AS (
      UPDATE resource_pipeline p
      SET claim_owner = ${owner}::uuid, claim_owner_at = NOW(),
          status = 'processing', error = NULL, updated = NOW()
      WHERE p.resource_id = ${resourceId}::uuid
        AND (
          p.claim_owner IS NULL
          OR GREATEST(
               p.claim_owner_at,
               (SELECT MAX(s.started_at) FROM resource_pipeline_step s WHERE s.pipeline_id = p.id)
             ) < NOW() - ${`${Math.trunc(staleAfterMs)} milliseconds`}::interval
        )
      RETURNING p.id
    ),
    cleared AS (
      DELETE FROM resource_pipeline_step s USING claimed c WHERE s.pipeline_id = c.id
    )
    SELECT id FROM claimed
  `)
  return (result.rows[0] as { id: string } | undefined) ?? null
}

/**
 * Give the claim up, so the next run does not have to wait out the staleness
 * window.
 *
 * Conditioned on still holding it: a run that was taken over must not release
 * the claim of whoever took it, which is the whole reason the owner is recorded
 * rather than inferred from `status`.
 */
export async function releasePipelineClaim(
  db: Database,
  pipelineId: string,
  owner: string
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE resource_pipeline
    SET claim_owner = NULL, claim_owner_at = NULL, updated = NOW()
    WHERE id = ${pipelineId}::uuid AND claim_owner = ${owner}::uuid
    RETURNING id
  `)
  return result.rows.length > 0
}

/**
 * Whether anyone currently holds the resource.
 *
 * Distinguishes "busy" from "no pipeline row", which a refused claim cannot:
 * both come back as null, and only the first is worth coming back for.
 */
export async function pipelineClaimHolder(db: Database, resourceId: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 FROM resource_pipeline
    WHERE resource_id = ${resourceId}::uuid AND claim_owner IS NOT NULL
  `)
  return result.rows.length > 0
}
