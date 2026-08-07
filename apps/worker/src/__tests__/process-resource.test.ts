import { describe, it, expect, vi, beforeEach } from 'vitest'
import { processResource } from '../pipeline/process-resource'
import type { Database } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'

// Mock all step modules
vi.mock('../pipeline/steps/fetch', () => ({
  executeFetch: vi.fn(),
}))
vi.mock('../pipeline/steps/interpret', () => ({
  executeInterpret: vi.fn(),
}))
vi.mock('../pipeline/steps/lake', () => ({
  executeLake: vi.fn(),
}))
vi.mock('../pipeline/steps/index-content', () => ({
  executeIndexContent: vi.fn(),
}))

// Mock StepTracker
const mockTracker = {
  beginRun: vi.fn(),
  mergeMetadata: vi.fn(),
  startStep: vi.fn(),
  completeStep: vi.fn(),
  failStep: vi.fn(),
  failOpenStep: vi.fn(),
  skipStep: vi.fn(),
  updateStatus: vi.fn(),
  updateInterpretResult: vi.fn(),
}

vi.mock('../pipeline/step-tracker', () => ({
  StepTracker: vi.fn(function () {
    return mockTracker
  }),
  // The run's exit when it has been killed; the orchestrator branches on it.
  RunCancelledError: class RunCancelledError extends Error {},
}))

/**
 * The claim is the database's (ADR-044) and is tested against a real one; what
 * belongs here is what the run does with each answer it gets back.
 */
const claim = vi.hoisted(() => ({ answer: 'ran' as 'ran' | 'held' | 'absent' }))

vi.mock('@kukan/api/services/pipeline-claim', () => ({
  withResourceClaim: vi.fn(
    async (
      _db: unknown,
      resourceId: string,
      fn: (c: { id: string; resourceId: string; owner: string }) => Promise<void>
    ) => {
      if (claim.answer !== 'ran') return { status: claim.answer }
      return { status: 'ran', result: await fn({ id: 'pipeline-1', resourceId, owner: 'run-1' }) }
    }
  ),
}))

// Import mocked modules
import { executeFetch } from '../pipeline/steps/fetch'
import { executeInterpret } from '../pipeline/steps/interpret'
import { executeLake } from '../pipeline/steps/lake'
import { executeIndexContent } from '../pipeline/steps/index-content'
import {
  createPipelineContextMock,
  type PipelineContextMock,
} from './test-helpers/pipeline-context'

function createMockCtx(): PipelineContextMock {
  const ctx = createPipelineContextMock()
  ctx.createVersion.mockResolvedValue({ created: true, version: 1 })
  // What the interpretation reads (ADR-046): the version holding this run's content.
  ctx.versionForContent.mockResolvedValue({
    version: 1,
    storageKey: 'versions/pkg-1/res-1/v1',
    size: 42,
    format: 'CSV',
  })
  return ctx
}

/**
 * Make the mocked interpretation hand a table to its caller, the way the real
 * one does once the Parquet is on disk (ADR-046). Without this the hook never
 * fires and the Lake step has nothing to load.
 */
const TABLE_PATH = '/tmp/kukan-x/data.csv.parquet'
const TABLE_PREVIEW_KEY = 'previews/pkg-1/res-1.tok.parquet'

function interpretProducesTable() {
  vi.mocked(executeInterpret).mockImplementation(async (_r, _p, _s, _f, _ctx, hooks) => {
    await hooks?.onTable?.(TABLE_PATH)
    return { previewKey: TABLE_PREVIEW_KEY, encoding: 'UTF8' }
  })
}

/** Steps in order, so an assertion names the step rather than a number. */
const STEP = {
  fetch: 'step-0',
  version: 'step-1',
  interpret: 'step-2',
  lake: 'step-3',
  index: 'step-4',
}

function createMockQueue(): QueueAdapter {
  return {
    enqueue: vi.fn().mockResolvedValue('job-requeue'),
    getStats: vi.fn(),
    process: vi.fn(),
    stop: vi.fn(),
  }
}

describe('processResource', () => {
  let ctx: PipelineContextMock
  let db: Database
  let queue: QueueAdapter
  let stepCounter: number

  beforeEach(() => {
    vi.clearAllMocks()
    ctx = createMockCtx()
    db = {} as Database
    queue = createMockQueue()
    stepCounter = 0

    claim.answer = 'ran'
    mockTracker.beginRun.mockResolvedValue(undefined)
    mockTracker.mergeMetadata.mockResolvedValue(undefined)
    mockTracker.startStep.mockImplementation(() => Promise.resolve(`step-${stepCounter++}`))
    mockTracker.completeStep.mockResolvedValue(undefined)
    mockTracker.failStep.mockResolvedValue(undefined)
    mockTracker.skipStep.mockResolvedValue(undefined)
    mockTracker.updateStatus.mockResolvedValue(undefined)
    mockTracker.updateInterpretResult.mockResolvedValue(null)

    // Version step defaults to creating a new version (v1).
    // Lake step defaults to a no-op (no DuckLake configured in these tests).
    vi.mocked(executeLake).mockResolvedValue({ status: 'skipped' })
  })

  it('should run all steps for CSV resource', async () => {
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
      hash: 'sha256:abc',
      size: 42,
      status: 'fetched',
    })
    vi.mocked(executeInterpret).mockResolvedValue({
      previewKey: 'previews/pkg-1/res-1.parquet',
      encoding: 'UTF8',
    })
    vi.mocked(executeIndexContent).mockResolvedValue({
      contentIndexed: true,
      contentType: 'tabular',
      contentOriginalSize: 5000,
      contentIndexedSize: 5000,
      contentTruncated: false,
      contentChunks: 1,
    })

    await processResource('res-1', ctx, db, queue)

    // The steps get this run's context, not the worker's: the writes that leave
    // the database are wrapped in a claim check (ADR-044 §4).
    const held = expect.objectContaining({ getResource: ctx.getResource })
    expect(executeFetch).toHaveBeenCalledWith('res-1', held, false)
    // The version file, not the live object: the input has to be one nothing
    // rewrites for the interpretation to be repeatable (ADR-046).
    expect(executeInterpret).toHaveBeenCalledWith(
      'res-1',
      'pkg-1',
      { storageKey: 'versions/pkg-1/res-1/v1', size: 42 },
      'CSV',
      held,
      { onEncoding: expect.any(Function), onTable: expect.any(Function) }
    )
    // Fetch + Version + Interpret + Lake + Index = 5 steps
    expect(mockTracker.startStep).toHaveBeenCalledTimes(5)
    expect(mockTracker.completeStep).toHaveBeenCalledWith(STEP.fetch)
    expect(mockTracker.updateStatus).toHaveBeenCalledWith('complete')
    expect(mockTracker.updateInterpretResult).toHaveBeenCalledWith('previews/pkg-1/res-1.parquet', {
      encoding: 'UTF8',
      // Ties the preview to the bytes Fetch measured (ADR-043 layer 2).
      sourceHash: 'sha256:abc',
    })
  })

  it('interprets a version under the format it was created with, not the label now (ADR-046)', async () => {
    // The label moved to TSV after these bytes were settled as a CSV. Reading
    // the current one would parse a settled version by a rule it was never read
    // with, and overwrite its schema with the result.
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'TSV',
      packageId: 'pkg-1',
      hash: 'sha256:abc',
      size: 42,
      status: 'fetched',
    })
    // The version stays on the fixture's CSV; only the label moved.
    vi.mocked(executeInterpret).mockResolvedValue({
      previewKey: 'previews/pkg-1/res-1.parquet',
      encoding: 'UTF8',
    })
    vi.mocked(executeIndexContent).mockResolvedValue(null)

    await processResource('res-1', ctx, db, queue)

    expect(executeInterpret).toHaveBeenCalledWith(
      'res-1',
      'pkg-1',
      { storageKey: 'versions/pkg-1/res-1/v1', size: 42 },
      'CSV',
      expect.anything(),
      expect.anything()
    )
    // Index reads the live object, so it keeps describing it by the resource's
    // own label — the two are answering different questions.
    expect(executeIndexContent).toHaveBeenCalledWith(
      'res-1',
      'pkg-1',
      'resources/pkg-1/res-1',
      'TSV',
      expect.anything(),
      expect.anything()
    )
  })

  it('should persist the column schema into metadata when the interpretation returns one (ADR-032)', async () => {
    const schema = {
      rowCount: 2,
      columns: [
        { name: 'id', type: 'integer' as const, nullable: false, nullCount: 0 },
        { name: 'name', type: 'string' as const, nullable: true, nullCount: 1 },
      ],
    }
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
      hash: 'sha256:abc',
      size: 42,
      status: 'fetched',
    })
    vi.mocked(executeInterpret).mockResolvedValue({
      previewKey: 'previews/pkg-1/res-1.parquet',
      encoding: 'UTF8',
      schema,
    })
    vi.mocked(executeIndexContent).mockResolvedValue(null)

    await processResource('res-1', ctx, db, queue)

    expect(mockTracker.updateInterpretResult).toHaveBeenCalledWith('previews/pkg-1/res-1.parquet', {
      encoding: 'UTF8',
      schema,
      sourceHash: 'sha256:abc',
    })
    // And onto the version it was read from, which is where the interpretation
    // belongs (ADR-046) — carrying the claim, since the row outlives the run.
    expect(ctx.recordVersionSchema).toHaveBeenCalledWith({
      resourceId: 'res-1',
      version: 1,
      schema,
      // A table came out, so there is nothing to say about why one did not.
      noTableReason: undefined,
      claim: expect.objectContaining({ owner: 'run-1' }),
    })
  })

  it('skips the interpretation when no version holds this run’s content', async () => {
    // The create failed, or another run moved the pointer. There is nothing
    // immutable to interpret, and the previous preview still describes some
    // content — so it is left alone rather than cleared (ADR-046).
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
      hash: 'sha256:abc',
      size: 42,
      status: 'fetched',
    })
    ctx.versionForContent.mockResolvedValue(null)
    vi.mocked(executeIndexContent).mockResolvedValue(null)

    await processResource('res-1', ctx, db, queue)

    expect(executeInterpret).not.toHaveBeenCalled()
    expect(mockTracker.skipStep).toHaveBeenCalledWith(STEP.interpret)
    expect(mockTracker.updateInterpretResult).not.toHaveBeenCalled()
    // Still advisory: the run completes and Index gets its own chance.
    expect(mockTracker.updateStatus).toHaveBeenCalledWith('complete')
  })

  it('creates the version without a schema (ADR-046)', async () => {
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
      hash: 'sha256:abc',
      size: 42,
      status: 'fetched',
    })
    vi.mocked(executeInterpret).mockResolvedValue(null)
    vi.mocked(executeIndexContent).mockResolvedValue(null)

    await processResource('res-1', ctx, db, queue)

    // The version is settled from its bytes; nothing has read the content yet.
    expect(ctx.createVersion).toHaveBeenCalledWith(
      expect.not.objectContaining({ schema: expect.anything() })
    )
    expect(ctx.createVersion.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.versionForContent.mock.invocationCallOrder[0]
    )
  })

  it('should skip interpret and index when format is unsupported', async () => {
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'PDF',
      packageId: 'pkg-1',
      hash: 'sha256:abc',
      size: 42,
      status: 'fetched',
    })
    vi.mocked(executeInterpret).mockResolvedValue(null)
    vi.mocked(executeIndexContent).mockResolvedValue(null)

    await processResource('res-1', ctx, db, queue)

    expect(mockTracker.skipStep).toHaveBeenCalledWith(STEP.interpret)
    expect(mockTracker.skipStep).toHaveBeenCalledWith(STEP.index)
    // Clears any stale preview/schema from a previous run (e.g. CSV → PDF replace).
    expect(mockTracker.updateInterpretResult).toHaveBeenCalledWith(null, {})
  })

  it('does NOT clear preview/schema when the interpretation throws (transient failure)', async () => {
    // A thrown extract is a transient failure — the previous preview/schema must
    // be preserved (unlike a null return, which means "no preview applies").
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
      hash: 'sha256:abc',
      size: 42,
      status: 'fetched',
    })
    vi.mocked(executeInterpret).mockRejectedValue(new Error('Parse error'))
    vi.mocked(executeIndexContent).mockResolvedValue(null)

    await processResource('res-1', ctx, db, queue)

    expect(mockTracker.failStep).toHaveBeenCalled()
    expect(mockTracker.updateInterpretResult).not.toHaveBeenCalled()
  })

  it('should complete even if the interpretation fails', async () => {
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
      hash: 'sha256:abc',
      size: 42,
      status: 'fetched',
    })
    vi.mocked(executeInterpret).mockRejectedValue(new Error('Parse error'))
    vi.mocked(executeIndexContent).mockResolvedValue(null)

    await processResource('res-1', ctx, db, queue)

    expect(mockTracker.failStep).toHaveBeenCalled()
    expect(mockTracker.startStep).toHaveBeenCalledTimes(5)
    expect(mockTracker.updateStatus).toHaveBeenCalledWith('complete')
  })

  it('should set error status if fetch fails', async () => {
    vi.mocked(executeFetch).mockRejectedValue(new Error('Download failed'))

    await processResource('res-1', ctx, db, queue)

    expect(mockTracker.updateStatus).toHaveBeenCalledWith('error', 'Download failed')
  })

  it('should close the step it failed in, not just the run', async () => {
    // Otherwise the row reads `error` while its step reads `running`, and the
    // UI — which shows the step — calls a failed resource in progress forever.
    vi.mocked(executeFetch).mockRejectedValue(new Error('Download failed'))

    await processResource('res-1', ctx, db, queue)

    expect(mockTracker.failOpenStep).toHaveBeenCalledWith('Download failed')
    // The run's record goes first: of the two states a half-done catch can
    // leave, `error` over a step still reading `running` at least says the run
    // is over.
    expect(mockTracker.updateStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mockTracker.failOpenStep.mock.invocationCallOrder[0]
    )
  })

  it('should say something when what was thrown is not an Error', async () => {
    // `(err as Error).message` is undefined for these, which would record a
    // failed step with no reason on the row the resource page reads.
    vi.mocked(executeFetch).mockRejectedValue('just a string')

    await processResource('res-1', ctx, db, queue)

    expect(mockTracker.updateStatus).toHaveBeenCalledWith('error', 'just a string')
    expect(mockTracker.failOpenStep).toHaveBeenCalledWith('just a string')
  })

  it('should requeue and set queued status when fetch is deferred', async () => {
    vi.mocked(executeFetch).mockResolvedValue({ status: 'deferred' })

    await processResource('res-1', ctx, db, queue)

    // Fetch step should be skipped
    expect(mockTracker.skipStep).toHaveBeenCalledWith(STEP.fetch)
    // Pipeline set back to queued
    expect(mockTracker.updateStatus).toHaveBeenCalledWith('queued')
    // Requeued with delay
    expect(queue.enqueue).toHaveBeenCalledWith(
      'resource-pipeline',
      { resourceId: 'res-1' },
      { delaySeconds: 6 }
    )
    // Interpret should NOT run
    expect(executeInterpret).not.toHaveBeenCalled()
    expect(mockTracker.startStep).toHaveBeenCalledTimes(1) // Only fetch step
  })

  it('does nothing when the resource is gone', async () => {
    claim.answer = 'absent'

    await processResource('res-1', ctx, db, queue)

    expect(executeFetch).not.toHaveBeenCalled()
    expect(mockTracker.startStep).not.toHaveBeenCalled()
    // Nothing is coming, so requeueing would spin forever.
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('comes back later when another run holds the resource', async () => {
    // SQS delivers at least once, and a replacement can arrive mid-run. The
    // holder read what it read, so dropping this job would leave the newer
    // content with no run of its own (ADR-044).
    claim.answer = 'held'

    await processResource('res-1', ctx, db, queue)

    expect(executeFetch).not.toHaveBeenCalled()
    expect(queue.enqueue).toHaveBeenCalledWith(
      'resource-pipeline',
      { resourceId: 'res-1' },
      expect.objectContaining({ delaySeconds: expect.any(Number) })
    )
  })

  it('carries the rebuild flag into the retry it comes back with', async () => {
    // Dropped here, the retry becomes an ordinary run — and for a resource
    // reverted because its URL served the wrong thing, that run publishes it
    // again. The flag has to survive contention, not just one delivery
    // (ADR-044 §4).
    claim.answer = 'held'

    await processResource('res-1', ctx, db, queue, { rebuildOnly: true })

    expect(queue.enqueue).toHaveBeenCalledWith(
      'resource-pipeline',
      { resourceId: 'res-1', rebuildOnly: true },
      expect.objectContaining({ delaySeconds: expect.any(Number) })
    )
  })

  it('rebuilds from the object the resource holds rather than fetching', async () => {
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
      hash: 'sha256:abc',
      size: 42,
      status: 'fetched',
    })

    await processResource('res-1', ctx, db, queue, { rebuildOnly: true })

    expect(executeFetch).toHaveBeenCalledWith('res-1', expect.anything(), true)
  })

  it('leaves without recording anything once it has been killed', async () => {
    // The kill is the claim being released, so the run finds out at its next
    // step boundary. It must not write `error` over the `cancelled` the killer
    // recorded, nor mark itself complete (ADR-044 §4).
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1.tok',
      format: 'CSV',
      packageId: 'pkg-1',
      hash: 'sha256:abc',
      size: 42,
      status: 'fetched',
    })
    const { RunCancelledError } = await import('../pipeline/step-tracker')
    mockTracker.startStep
      .mockImplementationOnce(() => Promise.resolve('step-0'))
      .mockImplementationOnce(() => Promise.reject(new RunCancelledError('res-1')))

    await processResource('res-1', ctx, db, queue)

    expect(mockTracker.updateStatus).not.toHaveBeenCalled()
    // The step record too — a killed run records nothing at all, and asserting
    // only on the row let the early return be moved below the step write.
    expect(mockTracker.failOpenStep).not.toHaveBeenCalled()
    expect(executeInterpret).not.toHaveBeenCalled()
  })

  it('records the run against the row it was given', async () => {
    // The claim names the pipeline row, so nothing has to look it up again —
    // and the reset that opens the run is safe only under it.
    vi.mocked(executeFetch).mockResolvedValue({ status: 'superseded' })

    await processResource('res-1', ctx, db, queue)

    expect(mockTracker.beginRun).toHaveBeenCalled()
  })

  it('loads the table interpretation produced, while it is still on disk', async () => {
    // Layer 2 reads the local Parquet rather than the preview in storage
    // (ADR-046), which is why the step runs from inside the interpretation.
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
      hash: 'sha256:abc',
      size: 42,
      status: 'fetched',
    })
    interpretProducesTable()
    vi.mocked(executeLake).mockResolvedValue({ status: 'ingested' })
    vi.mocked(executeIndexContent).mockResolvedValue(null)

    await processResource('res-1', ctx, db, queue)

    expect(executeLake).toHaveBeenCalledWith(
      {
        resourceId: 'res-1',
        sourcePath: TABLE_PATH,
        contentHash: 'sha256:abc',
      },
      expect.anything()
    )
    expect(mockTracker.completeStep).toHaveBeenCalledWith(STEP.lake)
  })

  it('records the Lake step as skipped when there was no table', async () => {
    // A non-tabular resource never reaches the hook, so nothing ran — and the
    // history says so rather than leaving the step off entirely.
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'PDF',
      packageId: 'pkg-1',
      hash: 'sha256:abc',
      size: 42,
      status: 'fetched',
    })
    vi.mocked(executeInterpret).mockResolvedValue(null)
    vi.mocked(executeIndexContent).mockResolvedValue(null)

    await processResource('res-1', ctx, db, queue)

    expect(executeLake).not.toHaveBeenCalled()
    expect(mockTracker.skipStep).toHaveBeenCalledWith(STEP.lake)
  })

  it('queues a retry when the Lake step could not ingest', async () => {
    // The next run ingests its own newer version and this one's Parquet is then
    // swept, so the pair would become permanently undiffable (ADR-043).
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1.tok',
      format: 'CSV',
      packageId: 'pkg-1',
      hash: 'sha256:abc',
      size: 10,
      status: 'fetched',
    })
    interpretProducesTable()
    vi.mocked(executeLake).mockResolvedValue({
      status: 'failed',
      version: 3,
      error: new Error('catalog unreachable'),
    })

    await processResource('res-1', ctx, db, queue)

    // Ids only: the Lake step put the Parquet on the version row, and the
    // handler reads it from there, so the message cannot disagree with it.
    expect(queue.enqueue).toHaveBeenCalledWith('lake-ingest-version', {
      resourceId: 'res-1',
      version: 3,
    })
    // Still advisory: the pipeline itself completes.
    expect(mockTracker.updateStatus).toHaveBeenCalledWith('complete')
  })
})
