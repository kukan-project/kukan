/**
 * KUKAN Pipeline — Resource Processing Orchestrator
 * Runs Fetch → Extract → Version → Lake → Index. Every step after Fetch records
 * its own failure and lets the pipeline continue: only the canonical file is
 * critical, and each derivative can be rebuilt on the next run.
 */

import type { Database } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import { LAKE_INGEST_JOB_TYPE, PIPELINE_JOB_TYPE } from '@kukan/shared'
import { StepTracker } from './step-tracker'
import { executeFetch } from './steps/fetch'
import { executeExtract } from './steps/extract'
import { executeLake } from './steps/lake'
import { executeIndexContent } from './steps/index-content'
import type { PipelineContext } from './types'
import { CLAIM_RETRY_DELAY_S, FETCH_RATE_LIMIT_REQUEUE_DELAY_S } from '@/config'

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
    // Held by another run (ADR-044), or there is no pipeline row at all. The
    // first has to come back: the holder read the content it read, so a
    // replacement that arrived after it started would otherwise never be
    // processed — the job would be dropped and nothing would record that work
    // was outstanding. Requeued with a delay rather than retried, so a long run
    // is not spun on.
    if (await tracker.claimHolder(resourceId)) {
      await queue.enqueue(PIPELINE_JOB_TYPE, { resourceId }, { delaySeconds: CLAIM_RETRY_DELAY_S })
    }
    return
  }

  try {
    // Step 1: Fetch — download external URL to Storage (uploads already there)
    const fetchStepId = await tracker.startStep(pipeline.id, 'fetch')
    const fetchResult = await executeFetch(resourceId, ctx)

    if (fetchResult.status === 'superseded') {
      // A newer run replaced the content while this one was fetching, and owns
      // the resource from here. Its bytes are already parked; the pipeline row
      // is left alone because that run is the one describing it.
      await tracker.skipStep(fetchStepId)
      return
    }

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

    await tracker.completeStep(fetchStepId)

    /**
     * Stop once a newer run has published (ADR-043).
     *
     * Publishing settles which object is the content; everything after it still
     * describes what this run read, so continuing would write stale previews,
     * search documents and pipeline state over the newer run's. Checked at each
     * boundary rather than once, because the steps in between are the long ones.
     *
     * The pipeline row is left alone — the run that owns the content is the one
     * that should describe it.
     */
    const supersededAfter = async (stepId: string): Promise<boolean> => {
      if (!(await ctx.isSuperseded(resourceId, fetchResult.storageKey))) return false
      await tracker.skipStep(stepId)
      return true
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
        // Extract produces no preview/schema for this format (non-text, e.g.
        // PDF/image — the Index step may still persist a document text-head
        // artifact, ADR-040).
        // Clear any stale values a previous run left behind — e.g. a resource
        // that was a CSV (with a schema + Parquet preview) and was then replaced
        // with a PDF must not keep reporting the old schema as queryable.
        // (A transient extract failure throws instead and is caught below, where
        // the previous preview is intentionally preserved.)
        await tracker.updateExtractResult(pipeline.id, null, {})
      } else {
        if (await supersededAfter(extractStepId)) return
        await tracker.completeStep(extractStepId)
        await tracker.updateExtractResult(pipeline.id, extractResult.previewKey, {
          encoding: extractResult.encoding,
          // Persist the column schema (ADR-032) when one was generated (CSV/TSV).
          ...(extractResult.schema ? { schema: extractResult.schema } : {}),
          // Ties the preview to the bytes it was built from, so a later run or
          // the backfill can tell whether it describes a given version
          // (ADR-043 layer 2). Extract read the object Fetch measured, so this
          // is that measurement rather than a second pass over the file.
          sourceHash: fetchResult.hash,
        })
      }
    } catch (err) {
      await tracker.failStep(extractStepId, (err as Error).message)
    }

    // Step 3: Version — capture an immutable copy of the canonical file (ADR-043).
    // Runs after Extract so the column schema can be snapshotted onto the version.
    // Non-critical: a capture failure is recorded but never fails the pipeline.
    const versionStepId = await tracker.startStep(pipeline.id, 'version')
    try {
      const versionResult = await ctx.captureVersion({
        resourceId,
        packageId: fetchResult.packageId,
        currentStorageKey: fetchResult.storageKey,
        contentHash: fetchResult.hash,
        contentSize: fetchResult.size,
        schema: extractResult?.schema ?? null,
      })
      if (versionResult.captured) {
        await tracker.completeStep(versionStepId)
      } else {
        await tracker.skipStep(versionStepId)
      }
    } catch (err) {
      await tracker.failStep(versionStepId, (err as Error).message)
    }

    // Step 4: Lake — load the captured version into DuckLake for row-level
    // diff (ADR-043 layer 2). Only runs for a newly captured tabular version;
    // non-critical, and rebuildable from layer 1 if it fails.
    const lakeStepId = await tracker.startStep(pipeline.id, 'lake')
    if (await supersededAfter(lakeStepId)) return
    try {
      const lakeResult = await executeLake(
        resourceId,
        extractResult?.previewKey ?? null,
        fetchResult.hash,
        ctx
      )
      if (lakeResult.status === 'ingested') {
        await tracker.completeStep(lakeStepId)
      } else if (lakeResult.status === 'skipped') {
        await tracker.skipStep(lakeStepId)
      } else {
        // Queued, because the next run ingests its own newer version and this
        // one's Parquet is then superseded and swept — after which the pair can
        // never be diffed.
        await tracker.failStep(lakeStepId, lakeResult.error.message)
        await queue.enqueue(LAKE_INGEST_JOB_TYPE, {
          resourceId,
          version: lakeResult.version,
          previewKey: lakeResult.previewKey,
        })
      }
    } catch (err) {
      await tracker.failStep(lakeStepId, (err as Error).message)
    }

    // Step 5: Index — extract text content and index to search engine
    // Non-critical: failures are recorded but don't fail the pipeline
    const indexStepId = await tracker.startStep(pipeline.id, 'index')
    if (await supersededAfter(indexStepId)) return
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
  } finally {
    // Every exit gives the claim up — the early returns for a superseded or
    // rate-limited run as much as the normal one. Left held, the resource would
    // sit out the staleness window before anything could touch it again.
    await tracker.releaseClaim(pipeline.id)
  }
}
