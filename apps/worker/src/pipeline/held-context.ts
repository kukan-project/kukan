/**
 * The pipeline context as one run may use it (ADR-044 §4).
 *
 * Every write a run makes to the database is conditioned on it still holding
 * the resource, which is what makes the kill a kill. Two kinds of write need
 * that condition put on them here rather than getting it from the statement
 * they are part of.
 *
 * The writes the statement can condition, and simply was not conditioning: the
 * pointer to the live content, so a stopped fetch cannot publish its bytes
 * afterwards and make a nonsense of a stop that promised to leave the content
 * alone; and the intent that a version still needs a Parquet, which the
 * resource keeps until something acts on it. Both take the claim into their own
 * statement, so for these it is a fence.
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
 * reach for these from a dozen places, one of them a loop over chunks. The
 * condition belongs where the capability is handed out, so the next call site
 * inherits it.
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
    async deferLakeIngest(row) {
      // The other write that carries its own condition.
      return ctx.deferLakeIngest({ ...row, claim })
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
