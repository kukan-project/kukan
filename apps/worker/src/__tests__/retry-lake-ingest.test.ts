import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Database } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { Logger } from '@kukan/shared'
import { retryLakeIngest } from '../pipeline/retry-lake-ingest'
import {
  createPipelineContextMock,
  type PipelineContextMock,
} from './test-helpers/pipeline-context'

/** The claim is the database's (ADR-044); what matters here is each answer. */
const claim = vi.hoisted(() => ({ answer: 'ran' as 'ran' | 'held' }))

vi.mock('@kukan/api/services/pipeline-claim', () => ({
  withResourceClaims: vi.fn(
    async (_db: unknown, ids: string[], fn: (claims: unknown[]) => Promise<unknown>) =>
      claim.answer === 'held'
        ? { status: 'held' }
        : {
            status: 'ran',
            result: await fn(ids.map((id) => ({ id: 'p', resourceId: id, owner: 'r' }))),
          }
  ),
}))

/** Whether the version is still waiting; the database's answer, stubbed. */
const pending = vi.hoisted(() => ({
  source: null as { storageKey: string; format: string } | null,
}))

vi.mock('@kukan/api/services/resource-version-service', () => ({
  pendingLakeVersionSource: vi.fn(async () => pending.source),
}))

/** The interpretation itself belongs to `interpret-version`; here it is a stub
 *  that hands over a table so the retry's own decisions are what is tested. */
const interpreted = vi.hoisted(() => ({ table: true }))

vi.mock('../pipeline/interpret-version', () => ({
  withInterpretedVersion: vi.fn(
    async (
      _source: unknown,
      _fmt: string,
      _ctx: unknown,
      use: (t: { parquetPath: string }) => Promise<unknown>
    ) =>
      interpreted.table
        ? {
            encoding: 'UTF8',
            schema: { rowCount: 1, columns: [] },
            used: await use({ parquetPath: '/tmp/kukan-x/v2.parquet' }),
          }
        : { encoding: 'UTF8', schema: { rowCount: 0, columns: [] } }
  ),
}))

import { withInterpretedVersion } from '../pipeline/interpret-version'

const VERSION_KEY = 'versions/pkg-1/res-1/v2'
const job = { resourceId: 'res-1', version: 2 }

let deps: { ctx: PipelineContextMock; db: Database; queue: QueueAdapter; log: Logger }

beforeEach(() => {
  vi.clearAllMocks()
  claim.answer = 'ran'
  interpreted.table = true
  pending.source = { storageKey: VERSION_KEY, format: 'CSV' }
  const ctx = createPipelineContextMock()
  ctx.ingestLakeVersion.mockResolvedValue({ snapshotId: 7 })
  deps = {
    ctx,
    db: {} as Database,
    queue: { enqueue: vi.fn().mockResolvedValue('job-1') } as never,
    log: { info: vi.fn(), warn: vi.fn() } as never,
  }
})

describe('retryLakeIngest', () => {
  it('interprets the version again and loads what came out', async () => {
    // The version file is immutable, so re-reading it gives the same table —
    // which is why nothing had to keep the first attempt's preview alive
    // (ADR-046).
    await retryLakeIngest(job, deps)

    expect(withInterpretedVersion).toHaveBeenCalledWith(
      { storageKey: VERSION_KEY },
      'csv',
      deps.ctx,
      expect.any(Function)
    )
    expect(deps.ctx.ingestLakeVersion).toHaveBeenCalledWith({
      ...job,
      sourcePath: '/tmp/kukan-x/v2.parquet',
    })
    expect(deps.queue.enqueue).not.toHaveBeenCalled()
  })

  it('records the interpretation even when it found no table', async () => {
    // An empty schema is how the version stops being outstanding: without it,
    // the hourly sweep hands the same empty CSV back every hour and every task
    // reads the file to find out there is nothing in it (ADR-046).
    interpreted.table = false

    await retryLakeIngest(job, deps)

    expect(deps.ctx.recordVersionSchema).toHaveBeenCalledWith(
      expect.objectContaining({ ...job, schema: { rowCount: 0, columns: [] } })
    )
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

  it('reads nothing when the version is not waiting to be loaded', async () => {
    // Redelivered after another pass ingested it, or after a purge. Asked
    // before anything is interpreted, because every worker task runs the hourly
    // sweep and enqueues the same version — all but one arrive to find the work
    // already done, and must not read a 50MB file to discover it.
    pending.source = null

    await retryLakeIngest(job, deps)

    expect(withInterpretedVersion).not.toHaveBeenCalled()
    expect(deps.ctx.ingestLakeVersion).not.toHaveBeenCalled()
  })

  it('does not requeue when the interpretation produced no table', async () => {
    // An empty CSV, say. Coming back would only spin: the input cannot change.
    interpreted.table = false

    await retryLakeIngest(job, deps)

    expect(deps.ctx.ingestLakeVersion).not.toHaveBeenCalled()
    expect(deps.queue.enqueue).not.toHaveBeenCalled()
  })
})
