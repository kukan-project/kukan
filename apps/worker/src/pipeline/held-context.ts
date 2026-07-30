/**
 * The pipeline context as one run may use it (ADR-044 §4).
 *
 * Every write a run makes to the database is conditioned on it still holding
 * the resource, which is what makes the kill a kill. The writes that leave the
 * database have no row to condition on: a chunk sent to OpenSearch, a version
 * loaded into the lake catalog. Those are the ones a stopped run could still
 * land — after the revert that deleted them — leaving the retracted content
 * searchable.
 *
 * Wrapped here rather than checked at each call site because the step bodies
 * reach for these six times across four functions, and one of them is a loop
 * over chunks. The check belongs where the capability is handed out, so a
 * seventh call site inherits it.
 *
 * It is a check, not a fence: the claim can go between the answer and the
 * write. What it buys is the size of that window — one chunk rather than a
 * whole step. Closing it entirely needs the index to carry the run that wrote
 * each document, which is a larger change than the exposure warrants.
 */
import type { Database } from '@kukan/db'
import { stillHolds, type ResourceClaim } from '@kukan/api/services/pipeline-claim'
import { RunCancelledError } from './step-tracker'
import type { PipelineContext } from './types'

export function heldContext(
  ctx: PipelineContext,
  claim: ResourceClaim,
  db: Database
): PipelineContext {
  const assertHeld = async () => {
    if (!(await stillHolds(db, claim))) throw new RunCancelledError(claim.resourceId)
  }

  return {
    ...ctx,
    async indexContent(doc) {
      await assertHeld()
      return ctx.indexContent(doc)
    },
    async deleteContent(resourceId) {
      await assertHeld()
      return ctx.deleteContent(resourceId)
    },
    async ingestLakeVersion(row) {
      await assertHeld()
      return ctx.ingestLakeVersion(row)
    },
  }
}
