/**
 * Retry a DuckLake ingest the pipeline's Lake step could not complete
 * (ADR-043 layer 2).
 *
 * The preview it names is the superseded one, kept alive because the version
 * names it too (ADR-043 §6-6) — the message is the fast path, not the record.
 * An hourly sweep finds the same versions from the database.
 */

import type { Database } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { Logger } from '@kukan/shared'
import { LAKE_INGEST_JOB_TYPE } from '@kukan/shared'
import { withResourceClaims } from '@kukan/api/services/pipeline-claim'
import { abandonLakeIngest } from '@kukan/api/services/lake-ingest'
import type { PipelineContext } from './types'
import { CLAIM_RETRY_DELAY_S } from '@/config'

export async function retryLakeIngest(
  job: { resourceId: string; version: number; previewKey: string },
  deps: {
    ctx: PipelineContext
    db: Database
    queue: QueueAdapter
    storage: StorageAdapter
    log: Logger
  }
): Promise<void> {
  const { resourceId, version, previewKey } = job
  const { log } = deps

  if (!(await deps.storage.head(previewKey))) {
    // Give the pointer up with the attempt. Left naming an object that is gone,
    // it would keep this version in the pending count and have the hourly sweep
    // pick it up and fail on it every hour (ADR-043 §6-6).
    await abandonLakeIngest(deps.db, { resourceId, version })
    log.warn(
      { resourceId, version, previewKey },
      'Lake ingest retry abandoned — the preview it was built from is gone'
    )
    return
  }

  // Under the resource's claim like every other writer (ADR-044): a run or a
  // purge in flight is about to move the very version this is loading.
  const outcome = await withResourceClaims(deps.db, [resourceId], () =>
    deps.ctx.ingestLakeVersion({ resourceId, version, previewKey })
  )

  if (outcome.status === 'held') {
    // Comes back rather than failing: the holder releases within the staleness
    // window, and by then the ingest's own ordering guard decides whether this
    // version is still worth loading (ADR-043).
    await deps.queue.enqueue(
      LAKE_INGEST_JOB_TYPE,
      { resourceId, version, previewKey },
      { delaySeconds: CLAIM_RETRY_DELAY_S }
    )
    log.info({ resourceId, version }, 'Lake ingest retry requeued — the resource is held')
    return
  }

  log.info(
    { resourceId, version, snapshotId: outcome.result?.snapshotId },
    outcome.result ? 'Lake ingest retry completed' : 'Lake ingest retry skipped (already ingested)'
  )
}
