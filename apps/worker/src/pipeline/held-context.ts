/**
 * The pipeline context as one run may use it (ADR-044 §4).
 *
 * Every write a run makes to the database is conditioned on it still holding
 * the resource, which is what makes the kill a kill. Two kinds of write need
 * that condition put on them here rather than getting it from the statement
 * they are part of.
 *
 * The pointer to the live content, which the statement can condition and
 * simply was not: it is one of the two writes that outlive the run (the version
 * row is the other), so a stopped fetch could publish its bytes afterwards and
 * a stop that promises to leave the content alone would not.
 *
 * And the writes that leave the database, which have no row to condition on: a
 * chunk sent to OpenSearch, a version loaded into the lake catalog. Those are
 * the ones a stopped run could still land — after the revert that deleted them
 * — leaving the retracted content searchable. For these it is a check, not a
 * fence: the claim can go between the answer and the write. What it buys is the
 * size of that window — one chunk rather than a whole step. Closing it entirely
 * needs the index to carry the run that wrote each document, which is a larger
 * change than the exposure warrants.
 *
 * Wrapped here rather than handled at each call site because the step bodies
 * reach for these nine times across six functions, and one of them is a loop
 * over chunks. The condition belongs where the capability is handed out, so a
 * tenth call site inherits it.
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
    async publishContent(id, content) {
      // The claim travels with the content rather than being asked about
      // first: this one write can carry the condition into its own statement,
      // so it is a fence and not a window.
      return ctx.publishContent(id, { ...content, claim })
    },
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
