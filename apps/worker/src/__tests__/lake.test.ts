import { describe, it, expect } from 'vitest'
import { executeLake } from '../pipeline/steps/lake'
import { RunCancelledError } from '../pipeline/step-tracker'
import {
  createPipelineContextMock,
  type PipelineContextMock,
} from './test-helpers/pipeline-context'

const PARQUET = 'previews/pkg-1/res-1.tok.parquet'
const SOURCE = '/tmp/kukan-abc/data.csv.parquet'
const HASH = 'sha256:abc'

/** executeLake touches two context methods; the shared mock supplies the rest. */
function createCtx(): PipelineContextMock {
  const ctx = createPipelineContextMock()
  ctx.pendingLakeVersion.mockResolvedValue(2)
  ctx.ingestLakeVersion.mockResolvedValue({ snapshotId: 42 })
  return ctx
}

const opts = { resourceId: 'res-1', previewKey: PARQUET, sourcePath: SOURCE, contentHash: HASH }

/**
 * Only the version resolution and the failure bookkeeping live here. Whether a
 * resource is tabular is settled by the interpretation this runs inside, which
 * a resource with no table never reaches (ADR-046).
 */
describe('executeLake', () => {
  it('skips when no version holds these bytes awaiting ingest', async () => {
    const ctx = createCtx()
    ctx.pendingLakeVersion.mockResolvedValue(null)

    expect(await executeLake(opts, ctx)).toEqual({ status: 'skipped' })
    expect(ctx.ingestLakeVersion).not.toHaveBeenCalled()
  })

  it('loads the local table, not the preview in storage', async () => {
    // The whole point of the split (ADR-046): only the load is under the
    // catalog lock, and a local file needs no pointer keeping it alive.
    // Resolved from the content hash rather than "did this run capture", so a
    // version whose earlier ingest failed is retried on any later run.
    const ctx = createCtx()

    expect(await executeLake(opts, ctx)).toEqual({ status: 'ingested' })
    expect(ctx.pendingLakeVersion).toHaveBeenCalledWith('res-1', HASH)
    expect(ctx.ingestLakeVersion).toHaveBeenCalledWith({
      resourceId: 'res-1',
      version: 2,
      previewKey: PARQUET,
      sourcePath: SOURCE,
    })
    expect(ctx.deferLakeIngest).not.toHaveBeenCalled()
  })

  it('records the Parquet the version still needs before giving up', async () => {
    // Deferred to the uploaded preview, not the local file: that one is gone by
    // the time a retry runs. The pointer is what keeps it from being swept, and
    // what makes this version findable again if the message is lost (kukan#204).
    const ctx = createCtx()
    ctx.ingestLakeVersion.mockRejectedValue(new Error('catalog unreachable'))

    await executeLake(opts, ctx)

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

    expect(await executeLake(opts, ctx)).toEqual({
      status: 'failed',
      version: 2,
      error: expect.any(Error),
    })
  })

  it('lets a kill through rather than recording an intent for it', async () => {
    // The run-scoped context throws this when the claim is gone (ADR-044 §4).
    const ctx = createCtx()
    ctx.ingestLakeVersion.mockRejectedValue(new RunCancelledError('res-1'))

    await expect(executeLake(opts, ctx)).rejects.toBeInstanceOf(RunCancelledError)
    expect(ctx.deferLakeIngest).not.toHaveBeenCalled()
  })

  it('skips on a null ingest — no DuckLake config, or already ingested', async () => {
    const ctx = createCtx()
    ctx.ingestLakeVersion.mockResolvedValue(null)

    expect(await executeLake(opts, ctx)).toEqual({ status: 'skipped' })
  })
})
