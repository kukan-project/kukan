/**
 * KUKAN Pipeline — Resource Processing Orchestrator
 * Runs Fetch → Extract → Index steps with error isolation
 */

import { unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Database } from '@kukan/db'
import { ResourcePipelineService } from './pipeline-service'
import { fetchStep } from './steps/fetch'
import { extractStep } from './steps/extract'
import { indexSearchStep } from './steps/index-search'
import type { PipelineContext } from './types'
import type { PipelineStepName } from '@kukan/shared'

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
    throw new Error(`No pipeline record found for resource ${resourceId}`)
  }

  const tmpFile = join(tmpdir(), `kukan-pipeline-${resourceId}`)

  try {
    // Step 1: Fetch — download file to tmp
    const fetchResult = await runStep(pipelineService, pipeline.id, 'fetch', () =>
      fetchStep(resourceId, ctx, tmpFile)
    )

    if (fetchResult) {
      // Step 2: Extract — parse, generate preview, store to Storage (non-critical)
      const previewKey = await runStep(
        pipelineService,
        pipeline.id,
        'extract',
        () =>
          extractStep(
            resourceId,
            fetchResult.packageId,
            fetchResult.tmpFile,
            fetchResult.format,
            ctx
          ),
        true // non-critical: catch errors, continue
      )

      if (previewKey) {
        await pipelineService.updatePreviewKey(pipeline.id, previewKey)
      }
    }

    // Step 3: Index — always runs
    await runStep(pipelineService, pipeline.id, 'index', () => indexSearchStep(resourceId, ctx))

    await pipelineService.updateStatus(pipeline.id, 'complete')
  } catch (err) {
    await pipelineService.updateStatus(pipeline.id, 'error', (err as Error).message)
  } finally {
    await unlink(tmpFile).catch(() => {})
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
