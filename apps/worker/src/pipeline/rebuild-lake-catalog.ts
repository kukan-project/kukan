/**
 * Rebuild one resource's layer 2 catalog from layer 1 (ADR-067 §6): a resource
 * with a version left behind a later one — the move off the shared catalog
 * among them — and the repair of a catalog whose objects are gone. A resource
 * that needs neither is cleared of what a failed write left instead (§2), and
 * the queue's retry of this job is what retries that clearing.
 *
 * Its own job because an ingest that finds the resource needs it is already
 * inside an interpretation, and a rebuild interprets every other version.
 */
import type { Database } from '@kukan/db'
import type { LakeConfig } from '@kukan/lake'
import type { JobQueue } from '@kukan/queue'
import type { Logger } from '@kukan/shared'
import { LAKE_REBUILD_JOB_TYPE } from '@kukan/shared'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { withResourceClaims } from '@kukan/api/services/pipeline/pipeline-claim'
import { clearLakeLeftovers } from '@kukan/api/services/lake/lake-catalog'
import {
  inspectLakeCatalog,
  lakeNeedsRebuild,
  rebuildResourceLake,
} from '@kukan/api/services/lake/lake-rebuild'
import { ResourceVersionService } from '@kukan/api/services/resource-version-service'
import { lakeVersionReader } from './lake-reader'
import type { PipelineContext } from './run/types'
import { CLAIM_RETRY_DELAY_S } from '@/config'

export async function rebuildLakeCatalog(
  job: { resourceId: string },
  deps: {
    ctx: PipelineContext
    db: Database
    queue: JobQueue
    storage: StorageAdapter
    lake: LakeConfig | undefined
    log: Logger
  }
): Promise<void> {
  const { resourceId } = job
  const { db, lake, log } = deps
  if (!lake) return
  // Every ingest of the resource queues one until it is done, so most arrive
  // to find another has finished it. A failed ingest or diff queues one too,
  // on the chance the catalog is what failed: asked here, not there.
  const catalogDeps = { lake, store: deps.storage, storage: deps.storage }

  // Asked under the claim, as is the clearing: a writer in flight has files no
  // catalog reads yet, and one that has just committed has moved the pointer
  // the answer was read from
  const outcome = await withResourceClaims(db, [resourceId], async (claims) => {
    const claim = claims[0] ?? null
    if (!(await lakeNeedsRebuild(db, resourceId))) {
      // Read whole, the catalog says what to keep while the rest is cleared
      const catalog = await inspectLakeCatalog(db, catalogDeps, resourceId)
      if (catalog !== 'broken') {
        const kept = catalog ?? undefined
        return { cleared: await clearLakeLeftovers(db, deps.storage, resourceId, claim, kept) }
      }
    }
    return {
      rebuilt: await rebuildResourceLake(
        db,
        { ...catalogDeps, readVersion: lakeVersionReader(deps.ctx, db) },
        resourceId,
        { claim }
      ),
    }
  })
  if (outcome.status === 'held') {
    await deps.queue.enqueue(
      LAKE_REBUILD_JOB_TYPE,
      { resourceId },
      { delaySeconds: CLAIM_RETRY_DELAY_S }
    )
    log.info({ resourceId }, 'Lake rebuild requeued — the resource is held')
    return
  }
  if ('cleared' in outcome.result) {
    log.info(
      { resourceId, cleared: outcome.result.cleared },
      'Lake rebuild skipped (nothing to rebuild); leftovers cleared'
    )
    return
  }
  const { loaded, refused } = outcome.result.rebuilt
  log.info({ resourceId, loaded: loaded.length, refused: refused.length }, 'Lake rebuild completed')
  // The version whose ingest queued this is still outstanding, as is any
  // created meanwhile: hand on to them now rather than at the next sweep
  await new ResourceVersionService(db).queueNextPendingLakeIngest(deps.queue, resourceId, 0)
}
