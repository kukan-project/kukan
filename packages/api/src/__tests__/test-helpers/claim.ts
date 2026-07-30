/**
 * A resource with a run in flight — the state every write that carries the
 * claim has to be tested against (ADR-044 §4).
 *
 * Shared because the writes that carry it are spread across services, so each
 * of their suites needs this same setup, and `claimResources` has already grown
 * an argument since the first copy of it was written.
 */
import { randomUUID } from 'node:crypto'
import { resourcePipeline } from '@kukan/db'
import {
  CLAIM_STALE_AFTER_MS,
  claimResources,
  type ResourceClaim,
} from '../../services/pipeline-claim'
import { getTestDb } from './test-db'

/** Give the resource a pipeline row and claim it, as a run would. */
export async function runInFlight(resourceId: string): Promise<ResourceClaim> {
  const db = getTestDb()
  await db.insert(resourcePipeline).values({ resourceId, status: 'processing' })
  const { claimed } = await claimResources(
    db,
    [resourceId],
    randomUUID(),
    CLAIM_STALE_AFTER_MS,
    'run'
  )
  return claimed[0]
}
