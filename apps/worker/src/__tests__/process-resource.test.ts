import { describe, it, expect, vi, beforeEach } from 'vitest'
import { processResource } from '../pipeline/process-resource'
import type { PipelineContext } from '../pipeline/types'
import type { Database } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'

// Mock all step modules
vi.mock('../pipeline/steps/fetch', () => ({
  executeFetch: vi.fn(),
}))
vi.mock('../pipeline/steps/extract', () => ({
  executeExtract: vi.fn(),
}))
vi.mock('../pipeline/steps/lake', () => ({
  executeLake: vi.fn(),
}))
vi.mock('../pipeline/steps/index-content', () => ({
  executeIndexContent: vi.fn(),
}))

// Mock StepTracker
const mockTracker = {
  startPipeline: vi.fn(),
  startStep: vi.fn(),
  completeStep: vi.fn(),
  failStep: vi.fn(),
  skipStep: vi.fn(),
  updateStatus: vi.fn(),
  updateExtractResult: vi.fn(),
}

vi.mock('../pipeline/step-tracker', () => ({
  StepTracker: vi.fn(function () {
    return mockTracker
  }),
}))

// Import mocked modules
import { executeFetch } from '../pipeline/steps/fetch'
import { executeExtract } from '../pipeline/steps/extract'
import { executeLake } from '../pipeline/steps/lake'
import { executeIndexContent } from '../pipeline/steps/index-content'

function createMockCtx(): PipelineContext {
  return {
    storage: { download: vi.fn(), upload: vi.fn(), copy: vi.fn() },
    getResource: vi.fn(),
    publishContent: vi.fn().mockResolvedValue(true),
    isSuperseded: vi.fn().mockResolvedValue(false),
    acquireFetchSlot: vi.fn().mockResolvedValue(true),
    indexContent: vi.fn(),
    deleteContent: vi.fn(),
    updatePipelineMetadata: vi.fn(),
    captureVersion: vi.fn().mockResolvedValue({ captured: true, version: 1 }),
    withVersionCaptureLock: vi.fn((_id: string, fn: () => Promise<unknown>) => fn()),
  }
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
  let ctx: PipelineContext
  let db: Database
  let queue: QueueAdapter
  let stepCounter: number

  beforeEach(() => {
    vi.clearAllMocks()
    ctx = createMockCtx()
    db = {} as Database
    queue = createMockQueue()
    stepCounter = 0

    mockTracker.startPipeline.mockResolvedValue({ id: 'pipeline-1' })
    mockTracker.startStep.mockImplementation(() => Promise.resolve(`step-${stepCounter++}`))
    mockTracker.completeStep.mockResolvedValue(undefined)
    mockTracker.failStep.mockResolvedValue(undefined)
    mockTracker.skipStep.mockResolvedValue(undefined)
    mockTracker.updateStatus.mockResolvedValue(undefined)
    mockTracker.updateExtractResult.mockResolvedValue(null)

    // Version step defaults to capturing a new version (v1).
    // Lake step defaults to a no-op (no DuckLake configured in these tests).
    vi.mocked(executeLake).mockResolvedValue({ status: 'skipped' })
  })

  it('should run all steps for CSV resource', async () => {
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
      status: 'fetched',
    })
    vi.mocked(executeExtract).mockResolvedValue({
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

    expect(executeFetch).toHaveBeenCalledWith('res-1', ctx)
    expect(executeExtract).toHaveBeenCalledWith(
      'res-1',
      'pkg-1',
      'resources/pkg-1/res-1',
      'CSV',
      ctx
    )
    // Fetch + Extract + Version + Lake + Index = 5 steps
    expect(mockTracker.startStep).toHaveBeenCalledTimes(5)
    expect(mockTracker.completeStep).toHaveBeenCalledWith('step-0')
    expect(mockTracker.updateStatus).toHaveBeenCalledWith('pipeline-1', 'complete')
    expect(mockTracker.updateExtractResult).toHaveBeenCalledWith(
      'pipeline-1',
      'previews/pkg-1/res-1.parquet',
      { encoding: 'UTF8' }
    )
  })

  it('should persist the column schema into metadata when extract returns one (ADR-032)', async () => {
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
      status: 'fetched',
    })
    vi.mocked(executeExtract).mockResolvedValue({
      previewKey: 'previews/pkg-1/res-1.parquet',
      encoding: 'UTF8',
      schema,
    })
    vi.mocked(executeIndexContent).mockResolvedValue(null)

    await processResource('res-1', ctx, db, queue)

    expect(mockTracker.updateExtractResult).toHaveBeenCalledWith(
      'pipeline-1',
      'previews/pkg-1/res-1.parquet',
      { encoding: 'UTF8', schema }
    )
  })

  it('should skip extract and index when format is unsupported', async () => {
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'PDF',
      packageId: 'pkg-1',
      status: 'fetched',
    })
    vi.mocked(executeExtract).mockResolvedValue(null)
    vi.mocked(executeIndexContent).mockResolvedValue(null)

    await processResource('res-1', ctx, db, queue)

    expect(mockTracker.skipStep).toHaveBeenCalledWith('step-1') // extract skipped
    // step-2 = version, step-3 = lake (skipped: no preview Parquet), step-4 = index
    expect(mockTracker.skipStep).toHaveBeenCalledWith('step-4')
    // Clears any stale preview/schema from a previous run (e.g. CSV → PDF replace).
    expect(mockTracker.updateExtractResult).toHaveBeenCalledWith('pipeline-1', null, {})
  })

  it('does NOT clear preview/schema when extract throws (transient failure)', async () => {
    // A thrown extract is a transient failure — the previous preview/schema must
    // be preserved (unlike a null return, which means "no preview applies").
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
      status: 'fetched',
    })
    vi.mocked(executeExtract).mockRejectedValue(new Error('Parse error'))
    vi.mocked(executeIndexContent).mockResolvedValue(null)

    await processResource('res-1', ctx, db, queue)

    expect(mockTracker.failStep).toHaveBeenCalled()
    expect(mockTracker.updateExtractResult).not.toHaveBeenCalled()
  })

  it('should complete even if extract fails', async () => {
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
      status: 'fetched',
    })
    vi.mocked(executeExtract).mockRejectedValue(new Error('Parse error'))
    vi.mocked(executeIndexContent).mockResolvedValue(null)

    await processResource('res-1', ctx, db, queue)

    expect(mockTracker.failStep).toHaveBeenCalled()
    expect(mockTracker.startStep).toHaveBeenCalledTimes(5)
    expect(mockTracker.updateStatus).toHaveBeenCalledWith('pipeline-1', 'complete')
  })

  it('should set error status if fetch fails', async () => {
    vi.mocked(executeFetch).mockRejectedValue(new Error('Download failed'))

    await processResource('res-1', ctx, db, queue)

    expect(mockTracker.updateStatus).toHaveBeenCalledWith('pipeline-1', 'error', 'Download failed')
  })

  it('should requeue and set queued status when fetch is deferred', async () => {
    vi.mocked(executeFetch).mockResolvedValue({ status: 'deferred' })

    await processResource('res-1', ctx, db, queue)

    // Fetch step should be skipped
    expect(mockTracker.skipStep).toHaveBeenCalledWith('step-0')
    // Pipeline set back to queued
    expect(mockTracker.updateStatus).toHaveBeenCalledWith('pipeline-1', 'queued')
    // Requeued with delay
    expect(queue.enqueue).toHaveBeenCalledWith(
      'resource-pipeline',
      { resourceId: 'res-1' },
      { delaySeconds: 6 }
    )
    // Extract should NOT run
    expect(executeExtract).not.toHaveBeenCalled()
    expect(mockTracker.startStep).toHaveBeenCalledTimes(1) // Only fetch step
  })

  it('should return early when no pipeline record exists', async () => {
    mockTracker.startPipeline.mockResolvedValue(undefined)

    await processResource('res-1', ctx, db, queue)

    expect(executeFetch).not.toHaveBeenCalled()
    expect(mockTracker.startStep).not.toHaveBeenCalled()
  })

  it('stops before recording its work once a newer run has published', async () => {
    // Publishing settles which object is the content; a run that has been
    // overtaken must not write its stale preview, search document or pipeline
    // state over the newer run's.
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1.tok',
      format: 'CSV',
      packageId: 'pkg-1',
      status: 'fetched',
    })
    vi.mocked(executeExtract).mockResolvedValue({
      previewKey: 'previews/pkg-1/res-1.tok.parquet',
      encoding: 'UTF8',
    })
    vi.mocked(ctx.isSuperseded).mockResolvedValue(true)

    await processResource('res-1', ctx, db, queue)

    expect(mockTracker.updateExtractResult).not.toHaveBeenCalled()
    expect(executeLake).not.toHaveBeenCalled()
    expect(executeIndexContent).not.toHaveBeenCalled()
    // The pipeline row belongs to the run that owns the content.
    expect(mockTracker.updateStatus).not.toHaveBeenCalledWith('pipeline-1', 'complete')
  })

  it('checks for a newer run against the object it published', async () => {
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1.tok',
      format: 'CSV',
      packageId: 'pkg-1',
      status: 'fetched',
    })
    vi.mocked(executeExtract).mockResolvedValue(null)

    await processResource('res-1', ctx, db, queue)

    expect(ctx.isSuperseded).toHaveBeenCalledWith('res-1', 'resources/pkg-1/res-1.tok')
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
    vi.mocked(executeLake).mockResolvedValue({
      status: 'failed',
      version: 3,
      previewKey: 'previews/pkg-1/res-1.tok.parquet',
      error: new Error('catalog unreachable'),
    })

    await processResource('res-1', ctx, db, queue)

    expect(queue.enqueue).toHaveBeenCalledWith('lake-ingest-version', {
      resourceId: 'res-1',
      version: 3,
      previewKey: 'previews/pkg-1/res-1.tok.parquet',
    })
    // Still advisory: the pipeline itself completes.
    expect(mockTracker.updateStatus).toHaveBeenCalledWith('pipeline-1', 'complete')
  })
})
