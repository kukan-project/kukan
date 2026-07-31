/**
 * KUKAN Pipeline — Resource Processing Orchestrator
 * Runs Fetch → Version → Extract → Lake → Index. Every step after Fetch records
 * its own failure and lets the pipeline continue: only the canonical file is
 * critical, and each derivative can be rebuilt on the next run.
 *
 * Version comes before everything that reads the content (ADR-046). The bytes
 * are settled first, and every interpretation of them is then made from a file
 * that cannot change — so a step that fails leaves work a later run can redo
 * identically, rather than a derivative of content nothing kept.
 */

import type { Database } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import { LAKE_INGEST_JOB_TYPE, PIPELINE_JOB_TYPE } from '@kukan/shared'
import { withResourceClaim } from '@kukan/api/services/pipeline-claim'
import { RunCancelledError, StepTracker } from './step-tracker'
import { heldContext } from './held-context'
import { executeFetch } from './steps/fetch'
import { executeExtract } from './steps/extract'
import { executeLake, type LakeStepOptions } from './steps/lake'
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
  const outcome = await withResourceClaim(db, resourceId, (claim) =>
    // The context the steps get is this run's: the writes that leave the
    // database carry the claim check the row-level ones get for free.
    runPipeline(resourceId, new StepTracker(db, claim), heldContext(ctx, claim, db), queue)
  )

  // Held by another run or a purge (ADR-044). This job has to come back: the
  // holder read the content it read, so a replacement that arrived after it
  // started would otherwise never be processed — the job would be dropped and
  // nothing would record that work was outstanding. Requeued with a delay
  // rather than retried, so a long run is not spun on. A resource with no
  // pipeline row is the other refusal, and there is nothing to come back for.
  if (outcome.status === 'held') {
    await queue.enqueue(PIPELINE_JOB_TYPE, { resourceId }, { delaySeconds: CLAIM_RETRY_DELAY_S })
  }
}

/** The run itself, with the resource already claimed for its duration. */
async function runPipeline(
  resourceId: string,
  tracker: StepTracker,
  ctx: PipelineContext,
  queue: QueueAdapter
): Promise<void> {
  await tracker.beginRun()

  try {
    // Step 1: Fetch — download external URL to Storage (uploads already there)
    const fetchStepId = await tracker.startStep('fetch')
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
        tracker.updateStatus('queued'),
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

    // Step 2: Version — capture an immutable copy of the canonical file
    // (ADR-043). Nothing has read the content yet: the version is settled from
    // the bytes alone, and what they mean is worked out afterwards (ADR-046).
    // Non-critical: a capture failure is recorded but never fails the pipeline.
    const versionStepId = await tracker.startStep('version')
    try {
      const versionResult = await ctx.captureVersion({
        resourceId,
        packageId: fetchResult.packageId,
        currentStorageKey: fetchResult.storageKey,
        contentHash: fetchResult.hash,
        contentSize: fetchResult.size,
        claim: tracker.claim,
      })
      if (versionResult.captured) {
        await tracker.completeStep(versionStepId)
      } else {
        await tracker.skipStep(versionStepId)
      }
    } catch (err) {
      // A kill is not this step failing: the orchestrator leaves without
      // recording, because the record belongs to whoever holds the claim now.
      if (err instanceof RunCancelledError) throw err
      await tracker.failStep(versionStepId, (err as Error).message)
    }

    // Step 3: Extract — interpret the captured version, generate Parquet preview
    // Non-critical: failures are recorded but don't fail the pipeline
    //
    // Read from the version rather than the live object, whether or not this run
    // is the one that captured it: content that was already there is interpreted
    // from the version holding it, which is how a version whose earlier
    // interpretation failed gets another attempt.
    let extractResult: Awaited<ReturnType<typeof executeExtract>> = null
    // Set by the hook below. Layer 2 now loads from the table interpretation
    // wrote to local disk, so its step is recorded from inside the
    // interpretation — ordered after this one, since steps are read by
    // `started_at`.
    let lakeRan = false
    const extractStepId = await tracker.startStep('extract')
    try {
      const version = await ctx.versionForContent(resourceId, fetchResult.hash)
      if (version === null) {
        // Nothing holds this run's content: the capture failed, or the pointer
        // moved and another run is describing the resource now. The previous
        // preview is left in place rather than cleared — it still describes some
        // content, and this run has none to replace it with.
        await tracker.skipStep(extractStepId)
      } else {
        extractResult = await executeExtract(
          resourceId,
          fetchResult.packageId,
          { storageKey: version.storageKey, size: version.size },
          fetchResult.format,
          ctx,
          {
            onTable: async (parquetPath) => {
              lakeRan = true
              await runLakeStep(tracker, queue, ctx, {
                resourceId,
                sourcePath: parquetPath,
                contentHash: fetchResult.hash,
              })
            },
          }
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
          await tracker.updateExtractResult(null, {})
        } else {
          await tracker.completeStep(extractStepId)
          await tracker.updateExtractResult(extractResult.previewKey, {
            encoding: extractResult.encoding,
            // Persist the column schema (ADR-032) when one was generated (CSV/TSV).
            ...(extractResult.schema ? { schema: extractResult.schema } : {}),
            // Ties the preview to the bytes it was built from, so a later run or
            // the backfill can tell whether it describes a given version
            // (ADR-043 layer 2). The version this read was found by that same
            // measurement, so it is not a second pass over the file.
            sourceHash: fetchResult.hash,
          })
          // And onto the version itself, which is where the interpretation
          // belongs (ADR-046). Still written to the pipeline row above: the
          // readers of ADR-032 go through it, and moving them to the version is
          // a change of its own.
          if (extractResult.schema) {
            await ctx.recordVersionSchema({
              resourceId,
              version: version.version,
              schema: extractResult.schema,
            })
          }
        }
      }
    } catch (err) {
      // A kill is not this step failing: the orchestrator leaves without
      // recording, because the record belongs to whoever holds the claim now.
      if (err instanceof RunCancelledError) throw err
      await tracker.failStep(extractStepId, (err as Error).message)
    }

    // Step 4: Lake — recorded above, from inside the interpretation, whenever
    // there was a table to load. Nothing to load means nothing ran, and the
    // step says so: a non-tabular resource, a format with no preview, or an
    // interpretation that failed before it produced one.
    if (!lakeRan) {
      await tracker.skipStep(await tracker.startStep('lake'))
    }

    // Step 5: Index — extract text content and index to search engine
    // Non-critical: failures are recorded but don't fail the pipeline
    const indexStepId = await tracker.startStep('index')
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
        await tracker.mergeMetadata({ contentIndexed: false })
      } else {
        await tracker.completeStep(indexStepId)
        await tracker.mergeMetadata({ ...indexResult })
      }
    } catch (err) {
      // A kill is not this step failing: the orchestrator leaves without
      // recording, because the record belongs to whoever holds the claim now.
      if (err instanceof RunCancelledError) throw err
      await tracker.failStep(indexStepId, (err as Error).message)
      await tracker.mergeMetadata({ contentIndexed: false })
    }

    await tracker.updateStatus('complete')
  } catch (err) {
    // A killed run records nothing: the resource was taken from it, and
    // `cancelled` is already on the row (ADR-044 §4).
    if (err instanceof RunCancelledError) return
    await tracker.updateStatus('error', (err as Error).message)
  }
}

/**
 * Load the interpreted table into DuckLake and record the step (ADR-043 layer 2).
 *
 * Called from inside the interpretation, while the table it loads is still on
 * local disk. Non-critical, and rebuildable from layer 1 — so a failure is
 * recorded and the run carries on, which is why this settles its own step
 * rather than letting anything propagate to the interpretation around it.
 */
async function runLakeStep(
  tracker: StepTracker,
  queue: QueueAdapter,
  ctx: PipelineContext,
  opts: LakeStepOptions
): Promise<void> {
  const lakeStepId = await tracker.startStep('lake')
  try {
    const lakeResult = await executeLake(opts, ctx)
    if (lakeResult.status === 'ingested') {
      await tracker.completeStep(lakeStepId)
    } else if (lakeResult.status === 'skipped') {
      await tracker.skipStep(lakeStepId)
    } else {
      // Queued, because the next run captures its own newer version and the
      // ordering guard then refuses this one for good — after which the pair
      // can never be diffed.
      await tracker.failStep(lakeStepId, lakeResult.error.message)
      // Ids only: the handler reads the version row and interprets its file
      // again, so a message carrying anything else could only disagree with it
      // (ADR-046).
      await queue.enqueue(LAKE_INGEST_JOB_TYPE, {
        resourceId: opts.resourceId,
        version: lakeResult.version,
      })
    }
  } catch (err) {
    // A kill is not this step failing: the orchestrator leaves without
    // recording, because the record belongs to whoever holds the claim now.
    if (err instanceof RunCancelledError) throw err
    await tracker.failStep(lakeStepId, (err as Error).message)
  }
}
