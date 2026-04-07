/**
 * KUKAN Pipeline — Resource Processing Orchestrator
 * Runs Fetch → Extract steps with error isolation.
 * Index step removed — indexing is handled by API route handlers on CUD.
 */

import type { Database } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import { PIPELINE_JOB_TYPE } from '@kukan/shared'
import { StepTracker } from './step-tracker'
import { executeFetch } from './steps/fetch'
import { executeExtract } from './steps/extract'
import type { PipelineContext } from './types'
import { FETCH_RATE_LIMIT_REQUEUE_DELAY_S } from '@/config'

/**
 * Process a resource through the full pipeline.
 * Each step is recorded in resource_pipeline_step.
 * Extract failure is caught so the pipeline can still complete.
 *
 * @param db - Database instance for pipeline state management (resource_pipeline tables)
 * @param queue - Queue adapter for requeueing rate-limited fetches
 */
export async function processResource(
  resourceId: string,
  ctx: PipelineContext,
  db: Database,
  queue: QueueAdapter
): Promise<void> {
  const tracker = new StepTracker(db)
  const pipeline = await tracker.startPipeline(resourceId)

  if (!pipeline) {
    // No pipeline record exists for this resource — nothing to process
    return
  }

  try {
    // Step 1: Fetch — download external URL to Storage (uploads already there)
    const fetchStepId = await tracker.startStep(pipeline.id, 'fetch')
    const fetchResult = await executeFetch(resourceId, ctx)

    if (fetchResult.status === 'deferred') {
      // Rate-limited — requeue with delay and revert pipeline to 'queued'
      await Promise.all([
        tracker.skipStep(fetchStepId),
        tracker.updateStatus(pipeline.id, 'queued'),
        queue.enqueue(PIPELINE_JOB_TYPE, { resourceId }, {
          delaySeconds: FETCH_RATE_LIMIT_REQUEUE_DELAY_S,
        }),
      ])
      return
    }

    if (fetchResult.status === 'skipped') {
      await tracker.skipStep(fetchStepId)
    } else {
      await tracker.completeStep(fetchStepId)
    }

    // Step 2: Extract — parse from Storage, generate Parquet preview
    // Non-critical: failures are recorded but don't fail the pipeline
    const extractStepId = await tracker.startStep(pipeline.id, 'extract')
    try {
      const extractResult = await executeExtract(
        resourceId,
        fetchResult.packageId,
        fetchResult.storageKey,
        fetchResult.format,
        ctx
      )
      if (extractResult === null) {
        await tracker.skipStep(extractStepId)
      } else {
        await tracker.completeStep(extractStepId)
        await tracker.updateExtractResult(pipeline.id, extractResult.previewKey, {
          encoding: extractResult.encoding,
        })
      }
    } catch (err) {
      await tracker.failStep(extractStepId, (err as Error).message)
    }

    await tracker.updateStatus(pipeline.id, 'complete')
  } catch (err) {
    await tracker.updateStatus(pipeline.id, 'error', (err as Error).message)
  }
}
