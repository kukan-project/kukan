import { describe, it, expect, vi, beforeEach } from 'vitest'
import { processResource } from '../pipeline/process-resource'
import type { PipelineContext } from '../pipeline/types'
import type { Database } from '@kukan/db'

// Mock all step modules
vi.mock('../pipeline/steps/fetch', () => ({
  executeFetch: vi.fn(),
}))
vi.mock('../pipeline/steps/extract', () => ({
  executeExtract: vi.fn(),
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
  StepTracker: vi.fn(() => mockTracker),
}))

// Import mocked modules
import { executeFetch } from '../pipeline/steps/fetch'
import { executeExtract } from '../pipeline/steps/extract'

function createMockCtx(): PipelineContext {
  return {
    storage: { download: vi.fn(), upload: vi.fn() },
    getResource: vi.fn(),
    updateResourceHashAndSize: vi.fn(),
  }
}

describe('processResource', () => {
  let ctx: PipelineContext
  let db: Database
  let stepCounter: number

  beforeEach(() => {
    vi.clearAllMocks()
    ctx = createMockCtx()
    db = {} as Database
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
    const mockFetchResult = {
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
    }
    vi.mocked(executeFetch).mockResolvedValue(mockFetchResult)
    vi.mocked(executeExtract).mockResolvedValue({
      previewKey: 'previews/pkg-1/res-1.parquet',
      encoding: 'UTF8',
    })

    await processResource('res-1', ctx, db)

    expect(executeFetch).toHaveBeenCalledWith('res-1', ctx)
    expect(executeExtract).toHaveBeenCalledWith(
      'res-1',
      'pkg-1',
      'resources/pkg-1/res-1',
      'CSV',
      ctx
    )
    // Fetch + Extract = 2 steps (index step removed)
    expect(mockTracker.startStep).toHaveBeenCalledTimes(2)
    expect(mockTracker.updateStatus).toHaveBeenCalledWith('pipeline-1', 'complete')
    expect(mockTracker.updateExtractResult).toHaveBeenCalledWith(
      'pipeline-1',
      'previews/pkg-1/res-1.parquet',
      { encoding: 'UTF8' }
    )
  })

  it('should skip extract when format is unsupported', async () => {
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'PDF',
      packageId: 'pkg-1',
    })
    vi.mocked(executeExtract).mockResolvedValue(null)

    await processResource('res-1', ctx, db)

    expect(mockTracker.skipStep).toHaveBeenCalledWith('step-1')
    expect(mockTracker.updateExtractResult).not.toHaveBeenCalled()
    expect(mockTracker.startStep).toHaveBeenCalledTimes(2)
    expect(mockTracker.updateStatus).toHaveBeenCalledWith('pipeline-1', 'complete')
  })

  it('should complete even if extract fails', async () => {
    vi.mocked(executeFetch).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
    })
    vi.mocked(executeExtract).mockRejectedValue(new Error('Parse error'))

    await processResource('res-1', ctx, db)

    expect(mockTracker.failStep).toHaveBeenCalled()
    expect(mockTracker.startStep).toHaveBeenCalledTimes(2)
    expect(mockTracker.updateStatus).toHaveBeenCalledWith('pipeline-1', 'complete')
  })

  it('should set error status if fetch fails', async () => {
    vi.mocked(executeFetch).mockRejectedValue(new Error('Download failed'))

    await processResource('res-1', ctx, db)

    expect(mockTracker.updateStatus).toHaveBeenCalledWith('pipeline-1', 'error', 'Download failed')
  })
})
