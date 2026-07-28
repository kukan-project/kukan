import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Database } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { Logger } from '@kukan/shared'
import { retryLakeIngest } from '../pipeline/retry-lake-ingest'
import type { PipelineContext } from '../pipeline/types'

/** The claim is the database's (ADR-044); what matters here is each answer. */
const claim = vi.hoisted(() => ({ answer: 'ran' as 'ran' | 'held' }))

vi.mock('@kukan/api/services/pipeline-claim', () => ({
  withResourceClaims: vi.fn(async (_db: unknown, _ids: string[], fn: () => Promise<unknown>) =>
    claim.answer === 'held' ? { status: 'held' } : { status: 'ran', result: await fn() }
  ),
}))

const job = { resourceId: 'res-1', version: 2, previewKey: 'previews/pkg-1/res-1.parquet' }

let deps: {
  ctx: PipelineContext
  db: Database
  queue: QueueAdapter
  storage: StorageAdapter
  log: Logger
}

beforeEach(() => {
  vi.clearAllMocks()
  claim.answer = 'ran'
  deps = {
    ctx: { ingestLakeVersion: vi.fn().mockResolvedValue({ snapshotId: 7 }) } as never,
    db: {} as Database,
    queue: { enqueue: vi.fn().mockResolvedValue('job-1') } as never,
    storage: { head: vi.fn().mockResolvedValue({ size: 10 }) } as never,
    log: { info: vi.fn(), warn: vi.fn() } as never,
  }
})

describe('retryLakeIngest', () => {
  it('ingests the version under the resource claim', async () => {
    await retryLakeIngest(job, deps)

    expect(deps.ctx.ingestLakeVersion).toHaveBeenCalledWith(job)
    expect(deps.queue.enqueue).not.toHaveBeenCalled()
  })

  it('comes back later when the resource is held', async () => {
    // A run or a purge in flight is about to move this very version. Requeued
    // rather than failed: the holder releases within the staleness window.
    claim.answer = 'held'

    await retryLakeIngest(job, deps)

    expect(deps.ctx.ingestLakeVersion).not.toHaveBeenCalled()
    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      'lake-ingest-version',
      job,
      expect.objectContaining({ delaySeconds: expect.any(Number) })
    )
  })

  it('gives up when the preview it was built from is gone', async () => {
    // Swept past the orphan retention — there is nothing left to ingest, so
    // coming back would only spin.
    vi.mocked(deps.storage.head).mockResolvedValue(null)

    await retryLakeIngest(job, deps)

    expect(deps.ctx.ingestLakeVersion).not.toHaveBeenCalled()
    expect(deps.queue.enqueue).not.toHaveBeenCalled()
  })
})
