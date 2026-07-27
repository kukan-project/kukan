import { describe, it, expect, vi } from 'vitest'
import { executeLake } from '../pipeline/steps/lake'
import type { PipelineContext } from '../pipeline/types'

const PARQUET = 'previews/pkg-1/res-1.tok.parquet'
const HASH = 'sha256:abc'

/** executeLake touches two context methods, so the rest is not stubbed. */
function createCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    pendingLakeVersion: vi.fn().mockResolvedValue(2),
    ingestLakeVersion: vi.fn().mockResolvedValue({ snapshotId: 42 }),
    ...overrides,
  } as unknown as PipelineContext
}

describe('executeLake', () => {
  it('skips resources with no preview at all (non-tabular or oversize)', async () => {
    const ctx = createCtx()

    expect(await executeLake('res-1', null, HASH, ctx)).toEqual({ ingested: false })
    expect(ctx.ingestLakeVersion).not.toHaveBeenCalled()
  })

  it('skips a non-Parquet preview — a ZIP manifest is not tabular', async () => {
    const ctx = createCtx()

    const result = await executeLake('res-1', 'previews/pkg-1/res-1.tok.json', HASH, ctx)

    expect(result).toEqual({ ingested: false })
    expect(ctx.ingestLakeVersion).not.toHaveBeenCalled()
  })

  it('skips when no version holds these bytes awaiting ingest', async () => {
    const ctx = createCtx({ pendingLakeVersion: vi.fn().mockResolvedValue(null) })

    expect(await executeLake('res-1', PARQUET, HASH, ctx)).toEqual({ ingested: false })
    expect(ctx.ingestLakeVersion).not.toHaveBeenCalled()
  })

  it('skips when the context carries no DuckLake config', async () => {
    const ctx = createCtx({ ingestLakeVersion: vi.fn().mockResolvedValue(null) })

    expect(await executeLake('res-1', PARQUET, HASH, ctx)).toEqual({ ingested: false })
  })

  it('ingests the version holding the bytes the preview was built from', async () => {
    // Resolved from the content hash rather than "did this run capture", so a
    // version whose earlier ingest failed is retried on any later run.
    const ctx = createCtx()

    expect(await executeLake('res-1', PARQUET, HASH, ctx)).toEqual({ ingested: true })
    expect(ctx.pendingLakeVersion).toHaveBeenCalledWith('res-1', HASH)
    expect(ctx.ingestLakeVersion).toHaveBeenCalledWith({
      resourceId: 'res-1',
      version: 2,
      previewKey: PARQUET,
    })
  })
})
