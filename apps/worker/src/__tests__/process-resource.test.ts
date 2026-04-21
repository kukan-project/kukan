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
import { executeIndexContent } from '../pipeline/steps/index-content'

function createMockCtx(): PipelineContext {
  return {
    storage: { download: vi.fn(), upload: vi.fn() },
    getResource: vi.fn(),
    updateResourceHashAndSize: vi.fn(),
    acquireFetchSlot: vi.fn().mockResolvedValue(true),
    indexContent: vi.fn(),
    updatePipelineMetadata: vi.fn(),
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
    mockTracker.updateExtractResult.mockResolvedValue(undefined)
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
    // Fetch + Extract + Index = 3 steps
    expect(mockTracker.startStep).toHaveBeenCalledTimes(3)
    expect(mockTracker.completeStep).toHaveBeenCalledWith('step-0')
    expect(mockTracker.updateStatus).toHaveBeenCalledWith('pipeline-1', 'complete')
    expect(mockTracker.updateExtractResult).toHaveBeenCalledWith(
      'pipeline-1',
      'previews/pkg-1/res-1.parquet',
      { encoding: 'UTF8' }
    )
  })

  it('should skip fetch step when upload already has hash', async () => {
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
      status: 'skipped',
    })
    vi.mocked(executeExtract).mockResolvedValue(null)
    vi.mocked(executeIndexContent).mockResolvedValue(null)

    await processResource('res-1', ctx, db, queue)

    expect(mockTracker.skipStep).toHaveBeenCalledWith('step-0')
    expect(mockTracker.updateStatus).toHaveBeenCalledWith('pipeline-1', 'complete')
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
    expect(mockTracker.skipStep).toHaveBeenCalledWith('step-2') // index skipped
    expect(mockTracker.updateExtractResult).not.toHaveBeenCalled()
    expect(mockTracker.startStep).toHaveBeenCalledTimes(3)
    expect(mockTracker.updateStatus).toHaveBeenCalledWith('pipeline-1', 'complete')
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
    expect(mockTracker.startStep).toHaveBeenCalledTimes(3)
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
      { delaySeconds: 2 }
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
})
