/**
 * KUKAN Pipeline — Resource Processing Orchestrator
 * Runs Fetch → Extract → Index steps with error isolation
 */

import type { Database } from '@kukan/db'
import { ResourcePipelineService } from './pipeline-service'
import { fetchStep } from './steps/fetch'
import { extractStep } from './steps/extract'
import type { PipelineContext, PipelineStepName } from './types'

/**
 * Process a resource through the full pipeline.
 * Each step is recorded in resource_pipeline_step.
 * Extract failure is caught so Index always runs.
 *
 * @param db - Database instance for pipeline state management (resource_pipeline tables)
 */
export async function processResource(
  resourceId: string,
  ctx: PipelineContext,
  db: Database
): Promise<void> {
  const pipelineService = new ResourcePipelineService(db)
  const pipeline = await pipelineService.startPipeline(resourceId)

  if (!pipeline) {
    // Pipeline is not in 'queued' state — already picked up by another job
    return
  }

  try {
    // Step 1: Fetch — download external URL to Storage (uploads already there)
    const fetchResult = await runStep(pipelineService, pipeline.id, 'fetch', () =>
      fetchStep(resourceId, ctx)
    )

    if (fetchResult) {
      // Step 2: Extract — parse from Storage, generate Parquet preview (non-critical)
      const extractResult = await runStep(
        pipelineService,
        pipeline.id,
        'extract',
        () =>
          extractStep(
            resourceId,
            fetchResult.packageId,
            fetchResult.storageKey,
            fetchResult.format,
            ctx
          ),
        true // non-critical: catch errors, continue
      )

      if (extractResult) {
        await pipelineService.updateExtractResult(pipeline.id, extractResult.previewKey, {
          encoding: extractResult.encoding,
        })
      }
    }

    // Step 3: Index — no-op (indexing handled by API route handlers on CUD)
    await runStep(pipelineService, pipeline.id, 'index', async () => null)

    await pipelineService.updateStatus(pipeline.id, 'complete')
  } catch (err) {
    await pipelineService.updateStatus(pipeline.id, 'error', (err as Error).message)
  }
}

/**
 * Execute a pipeline step with status tracking.
 * If nonCritical is true, errors are caught and null is returned instead of throwing.
 */
async function runStep<T>(
  pipelineService: ResourcePipelineService,
  pipelineId: string,
  stepName: PipelineStepName,
  fn: () => Promise<T>,
  nonCritical = false
): Promise<T | null> {
  const stepId = await pipelineService.startStep(pipelineId, stepName)
  try {
    const result = await fn()
    if (result === null) {
      // Step was skipped (e.g. unsupported format)
      await pipelineService.skipStep(stepId)
      return null
    }
    await pipelineService.completeStep(stepId)
    return result
  } catch (err) {
    await pipelineService.failStep(stepId, (err as Error).message)
    if (nonCritical) {
      return null
    }
    throw err
  }
}
