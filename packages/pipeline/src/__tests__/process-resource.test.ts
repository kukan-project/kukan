import { describe, it, expect, vi, beforeEach } from 'vitest'
import { processResource } from '../process-resource'
import type { PipelineContext } from '../types'
import type { Database } from '@kukan/db'

// Mock all step modules
vi.mock('../steps/fetch', () => ({
  fetchStep: vi.fn(),
}))
vi.mock('../steps/extract', () => ({
  extractStep: vi.fn(),
}))

// Mock ResourcePipelineService
const mockPipelineService = {
  startPipeline: vi.fn(),
  startStep: vi.fn(),
  completeStep: vi.fn(),
  failStep: vi.fn(),
  skipStep: vi.fn(),
  updateStatus: vi.fn(),
  updateExtractResult: vi.fn(),
}

vi.mock('../pipeline-service', () => ({
  ResourcePipelineService: vi.fn(() => mockPipelineService),
}))

// Import mocked modules
import { fetchStep } from '../steps/fetch'
import { extractStep } from '../steps/extract'

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

    mockPipelineService.startPipeline.mockResolvedValue({ id: 'pipeline-1' })
    mockPipelineService.startStep.mockImplementation(() => Promise.resolve(`step-${stepCounter++}`))
    mockPipelineService.completeStep.mockResolvedValue(undefined)
    mockPipelineService.failStep.mockResolvedValue(undefined)
    mockPipelineService.skipStep.mockResolvedValue(undefined)
    mockPipelineService.updateStatus.mockResolvedValue(undefined)
    mockPipelineService.updateExtractResult.mockResolvedValue(undefined)
  })

  it('should run all steps for CSV resource', async () => {
    const mockFetchResult = {
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
    }
    vi.mocked(fetchStep).mockResolvedValue(mockFetchResult)
    vi.mocked(extractStep).mockResolvedValue({
      previewKey: 'previews/pkg-1/res-1.parquet',
      encoding: 'UTF8',
    })

    await processResource('res-1', ctx, db)

    expect(fetchStep).toHaveBeenCalledWith('res-1', ctx)
    expect(extractStep).toHaveBeenCalledWith('res-1', 'pkg-1', 'resources/pkg-1/res-1', 'CSV', ctx)
    // Index step is a no-op but still recorded
    expect(mockPipelineService.startStep).toHaveBeenCalledTimes(3)
    expect(mockPipelineService.updateStatus).toHaveBeenCalledWith('pipeline-1', 'complete')
    expect(mockPipelineService.updateExtractResult).toHaveBeenCalledWith(
      'pipeline-1',
      'previews/pkg-1/res-1.parquet',
      { encoding: 'UTF8' }
    )
  })

  it('should skip extract when format is unsupported', async () => {
    vi.mocked(fetchStep).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'PDF',
      packageId: 'pkg-1',
    })
    vi.mocked(extractStep).mockResolvedValue(null)

    await processResource('res-1', ctx, db)

    expect(mockPipelineService.skipStep).toHaveBeenCalledWith('step-1')
    expect(mockPipelineService.updateExtractResult).not.toHaveBeenCalled()
    expect(mockPipelineService.startStep).toHaveBeenCalledTimes(3)
    expect(mockPipelineService.updateStatus).toHaveBeenCalledWith('pipeline-1', 'complete')
  })

  it('should continue to index even if extract fails', async () => {
    vi.mocked(fetchStep).mockResolvedValue({
      storageKey: 'resources/pkg-1/res-1',
      format: 'CSV',
      packageId: 'pkg-1',
    })
    vi.mocked(extractStep).mockRejectedValue(new Error('Parse error'))

    await processResource('res-1', ctx, db)

    expect(mockPipelineService.failStep).toHaveBeenCalled()
    expect(mockPipelineService.startStep).toHaveBeenCalledTimes(3)
    expect(mockPipelineService.updateStatus).toHaveBeenCalledWith('pipeline-1', 'complete')
  })

  it('should set error status if fetch fails', async () => {
    vi.mocked(fetchStep).mockRejectedValue(new Error('Download failed'))

    await processResource('res-1', ctx, db)

    expect(mockPipelineService.updateStatus).toHaveBeenCalledWith(
      'pipeline-1',
      'error',
      'Download failed'
    )
  })
})
