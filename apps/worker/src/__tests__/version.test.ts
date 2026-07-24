import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeVersion } from '../pipeline/steps/version'
import type { PipelineContext } from '../pipeline/types'

function createCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    storage: { download: vi.fn(), upload: vi.fn(), copy: vi.fn() },
    getResource: vi.fn(),
    updateResourceHashAndSize: vi.fn(),
    acquireFetchSlot: vi.fn(),
    indexContent: vi.fn(),
    deleteContent: vi.fn(),
    updatePipelineMetadata: vi.fn(),
    getVersionCaptureInfo: vi.fn().mockResolvedValue({ maxVersion: null, latestActiveHash: null }),
    insertResourceVersion: vi.fn(),
    ...overrides,
  } as PipelineContext
}

const RES = {
  id: 'res-1',
  packageId: 'pkg-1',
  name: null,
  description: null,
  url: null,
  urlType: 'upload' as const,
  format: 'CSV',
  hash: 'sha256:aaa',
  size: 123,
}

describe('executeVersion', () => {
  beforeEach(() => vi.clearAllMocks())

  it('captures v1 when no versions exist yet', async () => {
    const ctx = createCtx({ getResource: vi.fn().mockResolvedValue(RES) })
    const result = await executeVersion('res-1', 'pkg-1', 'resources/pkg-1/res-1', null, ctx)

    expect(result).toEqual({ captured: true, version: 1 })
    expect(ctx.storage.copy).toHaveBeenCalledWith(
      'resources/pkg-1/res-1',
      'versions/pkg-1/res-1/v1'
    )
    expect(ctx.insertResourceVersion).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1, origin: 'upload', hash: 'sha256:aaa', size: 123 })
    )
  })

  it('skips when the latest active version already holds this hash', async () => {
    const ctx = createCtx({
      getResource: vi.fn().mockResolvedValue(RES),
      getVersionCaptureInfo: vi
        .fn()
        .mockResolvedValue({ maxVersion: 2, latestActiveHash: 'sha256:aaa' }),
    })
    const result = await executeVersion('res-1', 'pkg-1', 'resources/pkg-1/res-1', null, ctx)

    expect(result).toEqual({ captured: false })
    expect(ctx.storage.copy).not.toHaveBeenCalled()
    expect(ctx.insertResourceVersion).not.toHaveBeenCalled()
  })

  it('assigns maxVersion+1 even when a purged tombstone sits on top', async () => {
    // v3 purged (tombstone) → latest active is v2's hash 'sha256:bbb'. New content
    // differs, so it must capture as v4 (never colliding on the unique index).
    const ctx = createCtx({
      getResource: vi.fn().mockResolvedValue(RES),
      getVersionCaptureInfo: vi
        .fn()
        .mockResolvedValue({ maxVersion: 3, latestActiveHash: 'sha256:bbb' }),
    })
    const result = await executeVersion('res-1', 'pkg-1', 'resources/pkg-1/res-1', null, ctx)

    expect(result).toEqual({ captured: true, version: 4 })
    expect(ctx.storage.copy).toHaveBeenCalledWith(
      'resources/pkg-1/res-1',
      'versions/pkg-1/res-1/v4'
    )
  })

  it('records origin=fetch for external URL resources', async () => {
    const ctx = createCtx({
      getResource: vi.fn().mockResolvedValue({ ...RES, urlType: 'external', url: 'https://x/y' }),
    })
    await executeVersion('res-1', 'pkg-1', 'resources/pkg-1/res-1', null, ctx)

    expect(ctx.insertResourceVersion).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'fetch' })
    )
  })

  it('skips when the resource has no content hash', async () => {
    const ctx = createCtx({
      getResource: vi.fn().mockResolvedValue({ ...RES, hash: null }),
    })
    const result = await executeVersion('res-1', 'pkg-1', 'resources/pkg-1/res-1', null, ctx)

    expect(result).toEqual({ captured: false })
    expect(ctx.storage.copy).not.toHaveBeenCalled()
  })
})
