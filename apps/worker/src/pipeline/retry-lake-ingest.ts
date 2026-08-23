/**
 * Retry a DuckLake ingest the pipeline could not complete (ADR-043 layer 2).
 *
 * Interprets the version again rather than reading something the first attempt
 * left behind (ADR-046). The version file is immutable, so the same input gives
 * the same table — which is why a failed ingest needs no pointer to a preview
 * kept alive on its behalf, and why the message is the fast path rather than
 * the record. An hourly sweep finds the same versions from the database.
 */

import type { Database } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { Logger } from '@kukan/shared'
import { LAKE_INGEST_JOB_TYPE } from '@kukan/shared'
import { withResourceClaims } from '@kukan/api/services/pipeline-claim'
import {
  pendingLakeVersionSource,
  ResourceVersionService,
} from '@kukan/api/services/resource-version-service'
import { withInterpretedVersion } from './interpret/version'
import type { PipelineContext } from './types'
import { CLAIM_RETRY_DELAY_S } from '@/config'

export async function retryLakeIngest(
  job: { resourceId: string; version: number },
  deps: { ctx: PipelineContext; db: Database; queue: QueueAdapter; log: Logger }
): Promise<void> {
  const { resourceId, version } = job
  const { ctx, log } = deps

  // Asked before anything is read — the same predicate the sweep queued from,
  // narrowed to this version, so there is no second opinion about what layer 2
  // covers. Every worker task runs that sweep, so the same version arrives
  // several times over; without this, all but one of them would download and
  // interpret up to 50MB to find out the work was already done.
  const source = await pendingLakeVersionSource(deps.db, job)
  if (!source) {
    log.info({ resourceId, version }, 'Lake ingest retry skipped (nothing outstanding)')
    // Still hand on. This is where a redelivery lands after the chain's own
    // enqueue failed: the version is already done, so without asking again the
    // backlog stops until the hourly sweep — the wait the chain exists to
    // remove. Duplicate messages reach it too and answer with the same next
    // version, which costs a redelivery of something already queued.
    await chainToNext(deps, resourceId, version, log)
    return
  }

  // Under the resource's claim like every other writer (ADR-044): a run or a
  // purge in flight is about to move the very version this is loading.
  const outcome = await withResourceClaims(deps.db, [resourceId], async (claims) => {
    const result = await withInterpretedVersion(
      { storageKey: source.storageKey, size: source.size },
      source.format.toLowerCase(),
      ctx,
      (t) => ctx.ingestLakeVersion({ resourceId, version, sourcePath: t.parquetPath })
    )
    // Written whether or not there was a table. An empty schema is how this
    // version stops being outstanding: without it, an empty CSV is handed back
    // by the hourly sweep every hour, and every task reads the file to find out
    // there is nothing in it (ADR-046). Null is the other case — nothing was
    // interpreted, so there is nothing to record.
    if (result.schema) {
      await ctx.recordVersionSchema({
        resourceId,
        version,
        schema: result.schema,
        // The same answer whichever caller ran, or a version interpreted through
        // this path would carry the empty schema with nothing to say why.
        noTableReason: result.reason,
        claim: claims[0] ?? undefined,
      })
    }
    return result
  })

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

  const ingested = outcome.result.used
  log.info(
    { resourceId, version, snapshotId: ingested?.snapshotId },
    ingested ? 'Lake ingest retry completed' : 'Lake ingest retry skipped (already ingested)'
  )

  await chainToNext(deps, resourceId, version, log)
}

/**
 * Hand on to the next version this resource owes layer 2.
 *
 * The sweep gives out one version per resource per hour, which is long enough
 * for new content to arrive above a backlog and overtake the rest of it for
 * good; chained, a resource drains in seconds.
 */
async function chainToNext(
  deps: { db: Database; queue: QueueAdapter },
  resourceId: string,
  handled: number,
  log: Logger
): Promise<void> {
  const service = new ResourceVersionService(deps.db)
  if (await service.queueNextPendingLakeIngest(deps.queue, resourceId, handled)) {
    log.info({ resourceId }, 'Queued the next version this resource owes layer 2')
  }
}
