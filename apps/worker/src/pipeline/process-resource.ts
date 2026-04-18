/**
 * KUKAN Pipeline — Resource Processing Orchestrator
 * Runs Fetch → Extract → Index steps with error isolation.
 */

import type { Database } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import { PIPELINE_JOB_TYPE } from '@kukan/shared'
import { StepTracker } from './step-tracker'
import { executeFetch } from './steps/fetch'
import { executeExtract } from './steps/extract'
import { executeIndexContent } from './steps/index-content'
import type { PipelineContext } from './types'
import { FETCH_RATE_LIMIT_REQUEUE_DELAY_S } from '@/config'

/**
 * Process a resource through the full pipeline.
 * Each step is recorded in resource_pipeline_step.
 * Extract/Index failures are caught so the pipeline can still complete.
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
        queue.enqueue(
          PIPELINE_JOB_TYPE,
          { resourceId },
          {
            delaySeconds: FETCH_RATE_LIMIT_REQUEUE_DELAY_S,
          }
        ),
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
    let extractResult: Awaited<ReturnType<typeof executeExtract>> = null
    const extractStepId = await tracker.startStep(pipeline.id, 'extract')
    try {
      extractResult = await executeExtract(
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

    // Step 3: Index — extract text content and index to search engine
    // Non-critical: failures are recorded but don't fail the pipeline
    const indexStepId = await tracker.startStep(pipeline.id, 'index')
    try {
      const indexResult = await executeIndexContent(
        resourceId,
        fetchResult.packageId,
        fetchResult.storageKey,
        fetchResult.format,
        extractResult,
        ctx
      )
      if (indexResult === null) {
        await tracker.skipStep(indexStepId)
        await ctx.updatePipelineMetadata(pipeline.id, { contentIndexed: false })
      } else {
        await tracker.completeStep(indexStepId)
        await ctx.updatePipelineMetadata(pipeline.id, { ...indexResult })
      }
    } catch (err) {
      await tracker.failStep(indexStepId, (err as Error).message)
      await ctx.updatePipelineMetadata(pipeline.id, { contentIndexed: false })
    }

    await tracker.updateStatus(pipeline.id, 'complete')
  } catch (err) {
    await tracker.updateStatus(pipeline.id, 'error', (err as Error).message)
  }
}
