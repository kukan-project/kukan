/**
 * Health check batch processor.
 * Queries stale resources, runs HEAD checks in parallel, updates DB,
 * and enqueues changed resources to the pipeline.
 */

import pLimit from 'p-limit'
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { Logger } from '@kukan/shared'
import { PIPELINE_JOB_TYPE } from '@kukan/shared'
import { HEALTH_CHECK_BATCH_SIZE, HEALTH_CHECK_CONCURRENCY } from '@/config'
import { executeHeadCheck } from './head-request'
import type { ResourceForHealthCheck, BatchSummary } from './types'

/**
 * Run a single health check batch:
 * 1. SELECT stale external URL resources
 * 2. HEAD check each with p-limit concurrency
 * 3. UPDATE health status in DB
 * 4. Enqueue changed resources (or no-header resources due for full fetch) to pipeline
 */
export async function checkBatch(
  db: Database,
  queue: QueueAdapter,
  stalenessHours: number,
  fullFetchIntervalHours: number,
  log: Logger
): Promise<BatchSummary> {
  const summary: BatchSummary = {
    total: 0,
    checked: 0,
    ok: 0,
    error: 0,
    changed: 0,
    enqueuedForFullFetch: 0,
  }

  // 1. SELECT stale resources using healthCheckedAt as implicit cursor
  const staleThreshold = sql`NOW() - ${`${stalenessHours} hours`}::interval`

  const batch = await db
    .select({
      id: resource.id,
      url: resource.url,
      hash: resource.hash,
      healthStatus: resource.healthStatus,
      healthCheckedAt: resource.healthCheckedAt,
      extras: resource.extras,
    })
    .from(resource)
    .where(
      and(
        isNull(resource.urlType),
        eq(resource.state, 'active'),
        sql`${resource.url} IS NOT NULL`,
        or(isNull(resource.healthCheckedAt), lt(resource.healthCheckedAt, staleThreshold))
      )
    )
    .orderBy(sql`${resource.healthCheckedAt} ASC NULLS FIRST`)
    .limit(HEALTH_CHECK_BATCH_SIZE)

  summary.total = batch.length

  if (batch.length === 0) {
    log.debug('No stale resources to check')
    return summary
  }

  log.info({ count: batch.length }, 'Starting health check batch')

  // 2. Run HEAD checks with p-limit concurrency
  const limit = pLimit(HEALTH_CHECK_CONCURRENCY)
  const fullFetchThreshold = fullFetchIntervalHours * 60 * 60 * 1000

  const tasks = batch.map((row) => {
    const res: ResourceForHealthCheck = {
      id: row.id,
      url: row.url!,
      hash: row.hash,
      healthStatus: row.healthStatus,
      healthCheckedAt: row.healthCheckedAt,
      extras: (row.extras as Record<string, unknown>) ?? {},
    }

    return limit(async () => {
      // Validate URL
      if (!URL.canParse(res.url)) {
        await updateHealthStatus(db, res.id, 'error', {
          healthError: 'Invalid URL',
        })
        summary.checked++
        summary.error++
        return
      }

      const result = await executeHeadCheck(res)
      summary.checked++

      if (result.healthStatus === 'ok') {
        summary.ok++
      } else {
        summary.error++
      }

      // 3. Update DB: healthStatus, healthCheckedAt, extras (jsonb merge)
      const healthMeta: Record<string, unknown> = {}
      if (result.etag !== null) healthMeta.healthEtag = result.etag
      if (result.lastModified !== null) healthMeta.healthLastModified = result.lastModified
      healthMeta.healthError = result.errorMessage
      if (result.httpStatus !== null) healthMeta.healthHttpStatus = result.httpStatus

      const hasHeaders = result.etag !== null || result.lastModified !== null

      await updateHealthStatus(db, res.id, result.healthStatus, healthMeta)

      // 4a. Enqueue changed resources to pipeline for re-fetch
      if (result.changed) {
        summary.changed++
        log.info(
          { resourceId: res.id, etag: result.etag, lastModified: result.lastModified },
          'Resource changed, enqueueing to pipeline'
        )
        await queue.enqueue(PIPELINE_JOB_TYPE, { resourceId: res.id })
        return
      }

      // 4b. No-header resources: periodic full fetch for hash comparison
      if (result.healthStatus === 'ok' && !hasHeaders) {
        const lastFullFetch = res.extras.healthLastFullFetchAt as number | undefined
        const needsFullFetch =
          lastFullFetch === undefined || Date.now() - lastFullFetch > fullFetchThreshold

        if (needsFullFetch) {
          summary.enqueuedForFullFetch++
          log.info({ resourceId: res.id }, 'No change headers, enqueueing periodic full fetch')
          await queue.enqueue(PIPELINE_JOB_TYPE, { resourceId: res.id })
          // Record the enqueue time so we don't re-enqueue until next interval
          await updateHealthStatus(db, res.id, null, { healthLastFullFetchAt: Date.now() })
        }
      }
    })
  })

  await Promise.all(tasks)

  log.info(summary, 'Health check batch complete')

  return summary
}

/** Update resource health extras, and optionally healthStatus + healthCheckedAt */
async function updateHealthStatus(
  db: Database,
  resourceId: string,
  healthStatus: 'ok' | 'error' | null,
  healthMeta: Record<string, unknown>
): Promise<void> {
  const metaJson = JSON.stringify(healthMeta)
  await db
    .update(resource)
    .set({
      ...(healthStatus !== null && { healthStatus, healthCheckedAt: sql`NOW()` }),
      extras: sql`COALESCE(${resource.extras}, '{}'::jsonb) || ${metaJson}::jsonb`,
    })
    .where(eq(resource.id, resourceId))
}
