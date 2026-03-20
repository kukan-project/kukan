import { describe, it, expect, vi, beforeEach } from 'vitest'
import { indexSearchStep } from '../steps/index-search'
import type { PipelineContext } from '../types'

function createMockCtx() {
  return {
    storage: { download: vi.fn(), upload: vi.fn() },
    search: { index: vi.fn() },
    getResource: vi.fn(),
    updateResourceHashAndSize: vi.fn(),
    getPackageForIndex: vi.fn(),
  } satisfies PipelineContext
}

describe('indexSearchStep', () => {
  let ctx: ReturnType<typeof createMockCtx>

  beforeEach(() => {
    ctx = createMockCtx()
  })

  it('should build DatasetDoc and call search.index', async () => {
    ctx.getResource.mockResolvedValue({
      id: 'res-1',
      packageId: 'pkg-1',
      url: null,
      urlType: 'upload',
      format: 'CSV',
      hash: null,
    })
    ctx.getPackageForIndex.mockResolvedValue({
      id: 'pkg-1',
      name: 'test-dataset',
      title: 'Test Dataset',
      notes: 'Some notes',
      ownerOrg: 'org-1',
      resources: [{ id: 'res-1', name: 'data.csv', description: 'Test data', format: 'CSV' }],
    })

    await indexSearchStep('res-1', ctx)

    expect(ctx.search.index).toHaveBeenCalledOnce()
    const doc = ctx.search.index.mock.calls[0][0]
    expect(doc.id).toBe('pkg-1')
    expect(doc.name).toBe('test-dataset')
    expect(doc.title).toBe('Test Dataset')
    expect(doc.organization).toBe('org-1')
    expect(doc.matchedResources).toHaveLength(1)
    expect(doc.matchedResources[0].id).toBe('res-1')
  })

  it('should skip if resource not found', async () => {
    ctx.getResource.mockResolvedValue(null)

    await indexSearchStep('nonexistent', ctx)

    expect(ctx.search.index).not.toHaveBeenCalled()
  })

  it('should skip if package not found', async () => {
    ctx.getResource.mockResolvedValue({
      id: 'res-1',
      packageId: 'pkg-1',
      url: null,
      urlType: null,
      format: null,
      hash: null,
    })
    ctx.getPackageForIndex.mockResolvedValue(null)

    await indexSearchStep('res-1', ctx)

    expect(ctx.search.index).not.toHaveBeenCalled()
  })
})
