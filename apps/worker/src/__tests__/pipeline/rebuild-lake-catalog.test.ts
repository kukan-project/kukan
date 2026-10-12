import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Database } from '@kukan/db'
import type { LakeConfig } from '@kukan/lake'
import type { JobQueue } from '@kukan/queue'
import type { Logger } from '@kukan/shared'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { rebuildLakeCatalog } from '../../pipeline/rebuild-lake-catalog'
import { inspectLakeCatalog, lakeNeedsRebuild } from '@kukan/api/services/lake/lake-rebuild'
import { createPipelineContextMock } from '../test-helpers/pipeline-context'

/** The claim is the database's (ADR-044); what matters here is each answer. */
const claim = vi.hoisted(() => ({ answer: 'ran' as 'ran' | 'held' }))
vi.mock('@kukan/api/services/pipeline/pipeline-claim', () => ({
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

const lake = vi.hoisted(() => ({
  needs: true,
  broken: false,
  clear: vi.fn(async (..._args: unknown[]) => 0),
  rebuild: vi.fn(async () => ({
    catalogKey: 'k',
    loaded: [{ version: 1, snapshotId: 1 }],
    refused: [],
  })),
}))
vi.mock('@kukan/api/services/lake/lake-catalog', () => ({
  clearLakeLeftovers: lake.clear,
}))
vi.mock('@kukan/api/services/lake/lake-rebuild', () => ({
  lakeNeedsRebuild: vi.fn(async () => lake.needs),
  inspectLakeCatalog: vi.fn(async () =>
    lake.broken ? 'broken' : { catalog: 'lake/r/g/catalog.k.sqlite', files: ['f.parquet'] }
  ),
  rebuildResourceLake: lake.rebuild,
}))

const chained = vi.hoisted(() => ({ next: vi.fn(async () => true) }))
vi.mock('@kukan/api/services/resource-version-service', () => ({
  ResourceVersionService: class {
    queueNextPendingLakeIngest = chained.next
  },
}))

const job = { resourceId: 'res-1' }
let deps: Parameters<typeof rebuildLakeCatalog>[1]

beforeEach(() => {
  vi.clearAllMocks()
  claim.answer = 'ran'
  lake.needs = true
  lake.broken = false
  deps = {
    ctx: createPipelineContextMock(),
    db: {} as Database,
    queue: { enqueue: vi.fn().mockResolvedValue('job-1') } as unknown as JobQueue,
    storage: {} as StorageAdapter,
    lake: {} as LakeConfig,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
  }
})

describe('rebuildLakeCatalog', () => {
  it('rebuilds under the claim, then hands on to the versions still owed', async () => {
    await rebuildLakeCatalog(job, deps)

    expect(lake.rebuild).toHaveBeenCalledWith(deps.db, expect.anything(), 'res-1', {
      claim: { id: 'p', resourceId: 'res-1', owner: 'r' },
    })
    expect(chained.next).toHaveBeenCalledWith(deps.queue, 'res-1', 0)
  })

  it('rebuilds a moved resource whose catalog cannot be read whole', async () => {
    // Queued by a failed ingest or diff, on the chance the catalog was what
    // failed (ADR-067 §6)
    lake.needs = false
    lake.broken = true

    await rebuildLakeCatalog(job, deps)

    expect(lake.rebuild).toHaveBeenCalled()
    expect(chained.next).toHaveBeenCalledWith(deps.queue, 'res-1', 0)
  })

  it('only clears leftovers, under the claim, when there is nothing to rebuild', async () => {
    // What a failed write could not clear itself (ADR-067 §2); the queue's
    // retry of this job retries the clearing
    lake.needs = false

    await rebuildLakeCatalog(job, deps)

    expect(lake.rebuild).not.toHaveBeenCalled()
    // Keeping what the catalog reads, as read once by the inspection
    expect(lake.clear).toHaveBeenCalledWith(
      deps.db,
      deps.storage,
      'res-1',
      { id: 'p', resourceId: 'res-1', owner: 'r' },
      { catalog: 'lake/r/g/catalog.k.sqlite', files: ['f.parquet'] }
    )
    expect(chained.next).not.toHaveBeenCalled()
  })

  it('fails, for the queue to retry, when the clearing fails', async () => {
    lake.needs = false
    lake.clear.mockRejectedValueOnce(new Error('delete failed'))

    await expect(rebuildLakeCatalog(job, deps)).rejects.toThrow('delete failed')
  })

  it('comes back later to clear while the resource is held', async () => {
    lake.needs = false
    claim.answer = 'held'

    await rebuildLakeCatalog(job, deps)

    expect(lake.clear).not.toHaveBeenCalled()
    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      'rebuild-lake-catalog',
      { resourceId: 'res-1' },
      expect.objectContaining({ delaySeconds: expect.any(Number) })
    )
  })

  it('comes back later while the resource is held, having asked nothing yet', async () => {
    // Asked under the claim: the holder may be the very writer that changes
    // the answer
    claim.answer = 'held'

    await rebuildLakeCatalog(job, deps)

    expect(lakeNeedsRebuild).not.toHaveBeenCalled()
    expect(inspectLakeCatalog).not.toHaveBeenCalled()
    expect(lake.rebuild).not.toHaveBeenCalled()
    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      'rebuild-lake-catalog',
      { resourceId: 'res-1' },
      expect.objectContaining({ delaySeconds: expect.any(Number) })
    )
  })

  it('does nothing without a lake', async () => {
    await rebuildLakeCatalog(job, { ...deps, lake: undefined })

    expect(lake.rebuild).not.toHaveBeenCalled()
  })
})
