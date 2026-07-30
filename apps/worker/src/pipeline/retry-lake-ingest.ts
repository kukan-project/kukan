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
import { abandonLakeIngest, pendingLakeSourceKey } from '@kukan/api/services/lake-ingest'
import type { PipelineContext } from './types'
import { CLAIM_RETRY_DELAY_S } from '@/config'

export async function retryLakeIngest(
  job: { resourceId: string; version: number },
  deps: {
    ctx: PipelineContext
    db: Database
    queue: QueueAdapter
    storage: StorageAdapter
    log: Logger
  }
): Promise<void> {
  const { resourceId, version } = job
  const { log } = deps

  // Resolved from the row, not from the message. Null means the version is not
  // waiting for a Parquet any more — the hourly pass ingested it, or a purge
  // took it — and a redelivered message must not undo that.
  const previewKey = await pendingLakeSourceKey(deps.db, job)
  if (!previewKey) {
    log.info({ resourceId, version }, 'Lake ingest retry skipped (nothing outstanding)')
    return
  }

  if (!(await deps.storage.head(previewKey))) {
    // Should not happen now the version names it: the sweep asks before
    // deleting, and this key is one of the answers (ADR-045 §3). Reaching here
    // means the object went some other way, so the intent goes with it —
    // otherwise this version sits in the pending count and the hourly pass
    // fails on it every hour.
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
      { resourceId, version },
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
