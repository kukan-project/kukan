import { describe, it, expect } from 'vitest'
import { executeLake } from '../pipeline/steps/lake'
import {
  createPipelineContextMock,
  type PipelineContextMock,
} from './test-helpers/pipeline-context'

const PARQUET = 'previews/pkg-1/res-1.tok.parquet'
const HASH = 'sha256:abc'

/** executeLake touches two context methods; the shared mock supplies the rest. */
function createCtx(): PipelineContextMock {
  const ctx = createPipelineContextMock()
  ctx.pendingLakeVersion.mockResolvedValue(2)
  ctx.ingestLakeVersion.mockResolvedValue({ snapshotId: 42 })
  return ctx
}

describe('executeLake', () => {
  it('skips resources with no preview at all (non-tabular or oversize)', async () => {
    const ctx = createCtx()

    expect(await executeLake('res-1', null, HASH, ctx)).toEqual({ status: 'skipped' })
    expect(ctx.ingestLakeVersion).not.toHaveBeenCalled()
  })

  it('skips a non-Parquet preview — a ZIP manifest is not tabular', async () => {
    const ctx = createCtx()

    const result = await executeLake('res-1', 'previews/pkg-1/res-1.tok.json', HASH, ctx)

    expect(result).toEqual({ status: 'skipped' })
    expect(ctx.ingestLakeVersion).not.toHaveBeenCalled()
  })

  it('skips when no version holds these bytes awaiting ingest', async () => {
    const ctx = createCtx()
    ctx.pendingLakeVersion.mockResolvedValue(null)

    expect(await executeLake('res-1', PARQUET, HASH, ctx)).toEqual({ status: 'skipped' })
    expect(ctx.ingestLakeVersion).not.toHaveBeenCalled()
  })

  it('skips when the context carries no DuckLake config', async () => {
    const ctx = createCtx()
    ctx.ingestLakeVersion.mockResolvedValue(null)

    expect(await executeLake('res-1', PARQUET, HASH, ctx)).toEqual({ status: 'skipped' })
  })

  it('ingests the version holding the bytes the preview was built from', async () => {
    // Resolved from the content hash rather than "did this run capture", so a
    // version whose earlier ingest failed is retried on any later run.
    const ctx = createCtx()

    expect(await executeLake('res-1', PARQUET, HASH, ctx)).toEqual({ status: 'ingested' })
    expect(ctx.pendingLakeVersion).toHaveBeenCalledWith('res-1', HASH)
    expect(ctx.ingestLakeVersion).toHaveBeenCalledWith({
      resourceId: 'res-1',
      version: 2,
      previewKey: PARQUET,
    })
    expect(ctx.deferLakeIngest).not.toHaveBeenCalled()
  })

  it('records the Parquet the version still needs before giving up', async () => {
    // The pointer is what keeps the preview from being swept, and what makes
    // this version findable again if the retry message is lost (kukan#204).
    const ctx = createCtx()
    ctx.ingestLakeVersion.mockRejectedValue(new Error('catalog unreachable'))

    await executeLake('res-1', PARQUET, HASH, ctx)

    expect(ctx.deferLakeIngest).toHaveBeenCalledWith({
      resourceId: 'res-1',
      version: 2,
      previewKey: PARQUET,
    })
  })

  it('names the version a retry has to come back for', async () => {
    // Waiting for the next run does not recover it: that run ingests its own
    // newer version. The Parquet is not handed back — it is on the version row
    // now, and the caller queues ids only (ADR-043 §6-6).
    const ctx = createCtx()
    ctx.ingestLakeVersion.mockRejectedValue(new Error('catalog unreachable'))

    expect(await executeLake('res-1', PARQUET, HASH, ctx)).toEqual({
      status: 'failed',
      version: 2,
      error: expect.any(Error),
    })
  })

  it('skips when something else ingested the version first', async () => {
    const ctx = createCtx()
    ctx.ingestLakeVersion.mockResolvedValue(null)

    expect(await executeLake('res-1', PARQUET, HASH, ctx)).toEqual({ status: 'skipped' })
  })
})
