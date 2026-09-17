import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createLogger } from '@kukan/shared'
import type { Database } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { SearchAdapter } from '@kukan/search-adapter'
import { reanalyseSearchIndex } from '../search/reanalyse-index'

const rebuildMetadataIndex = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ packagesIndexed: 3, resourcesIndexed: 9 })
)
const markContentUnindexed = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const enqueueMany = vi.hoisted(() => vi.fn())

vi.mock('@kukan/api/services/search-index', () => ({ rebuildMetadataIndex }))
vi.mock('@kukan/api/services/content-index-record', () => ({ markContentUnindexed }))
vi.mock('@kukan/api/services/pipeline-service', () => ({
  PipelineService: class {
    enqueueMany = enqueueMany
  },
}))

const log = createLogger({ name: 'test', level: 'silent' })
const queue = { enqueue: vi.fn() } as unknown as QueueAdapter

/**
 * `select` answers the content diff (resources the database still has) and
 * `selectDistinct` the resources whose Index step ran during the copy.
 */
function dbWith(liveIds: string[], indexedDuringCopy: string[] = []): Database {
  return {
    select: () => ({ from: () => ({ where: async () => liveIds.map((id) => ({ id })) }) }),
    selectDistinct: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async () => indexedDuringCopy.map((resourceId) => ({ resourceId })),
        }),
      }),
    }),
  } as unknown as Database
}

function searchWith(overrides: Partial<SearchAdapter> = {}) {
  return {
    analysisStale: vi.fn().mockResolvedValue(true),
    reanalyseIndex: vi.fn().mockResolvedValue({ from: 'a', to: 'b', documents: 12 }),
    pendingRepair: vi.fn().mockResolvedValue(new Date('2026-09-17T10:00:00.000Z')),
    markRepaired: vi.fn().mockResolvedValue(undefined),
    indexedContentResources: vi.fn().mockResolvedValue([]),
    deleteContent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SearchAdapter
}

describe('reanalyseSearchIndex', () => {
  beforeEach(() => {
    rebuildMetadataIndex.mockClear()
    markContentUnindexed.mockClear()
    enqueueMany.mockReset()
    enqueueMany.mockResolvedValue({ enqueued: 0, failed: [] })
  })

  it('repairs the index in this job, not in one queued behind it', async () => {
    const search = searchWith()

    const result = await reanalyseSearchIndex(dbWith([]), search, queue, log)

    expect(result).toEqual({ from: 'a', to: 'b', documents: 12 })
    expect(rebuildMetadataIndex).toHaveBeenCalledWith(expect.anything(), search, log, true)
    expect(search.markRepaired).toHaveBeenCalled()
  })

  it('repairs the window the live index carries, not one this delivery made up', async () => {
    // An attempt that swapped and then failed part-way leaves the marker; a
    // window made now would look back at nothing
    const search = searchWith({
      analysisStale: vi.fn().mockResolvedValue(false),
      pendingRepair: vi.fn().mockResolvedValue(new Date('2026-09-17T09:00:00.000Z')),
    })

    await reanalyseSearchIndex(dbWith([], ['res-a']), search, queue, log)

    expect(search.reanalyseIndex).not.toHaveBeenCalled()
    expect(rebuildMetadataIndex).toHaveBeenCalled()
    expect(search.markRepaired).toHaveBeenCalled()
  })

  it('does nothing where the live index owes no repair', async () => {
    const search = searchWith({
      analysisStale: vi.fn().mockResolvedValue(false),
      pendingRepair: vi.fn().mockResolvedValue(null),
    })

    await reanalyseSearchIndex(dbWith([]), search, queue, log)

    expect(rebuildMetadataIndex).not.toHaveBeenCalled()
    expect(search.markRepaired).not.toHaveBeenCalled()
  })

  it('drops content indexed for a resource the database no longer has', async () => {
    // Content hangs off the package, so a deleted resource's chunks are still
    // reached through a package that is still there
    const search = searchWith({
      indexedContentResources: vi.fn().mockResolvedValue(['gone-1', 'alive', 'gone-2']),
    })

    await reanalyseSearchIndex(dbWith(['alive']), search, queue, log)

    expect(search.deleteContent).toHaveBeenCalledWith('gone-1')
    expect(search.deleteContent).toHaveBeenCalledWith('gone-2')
    expect(search.deleteContent).not.toHaveBeenCalledWith('alive')
  })

  it('removes the text the copy carried before queueing the rebuild', async () => {
    // What the copy carried is whatever those writes replaced; leaving it until
    // a backlog clears is what this repair exists to prevent
    enqueueMany.mockResolvedValue({ enqueued: 2, failed: [] })
    const search = searchWith()

    await reanalyseSearchIndex(dbWith([], ['res-a', 'res-b']), search, queue, log)

    expect(search.deleteContent).toHaveBeenCalledWith('res-a')
    expect(search.deleteContent).toHaveBeenCalledWith('res-b')
    expect(markContentUnindexed).toHaveBeenCalledWith(expect.anything(), { resourceId: 'res-a' })
    expect(enqueueMany).toHaveBeenCalledWith([
      { id: 'res-a', rebuildOnly: true },
      { id: 'res-b', rebuildOnly: true },
    ])
  })

  it('leaves the repair owed when it cannot queue the rebuild', async () => {
    enqueueMany.mockResolvedValue({ enqueued: 1, failed: [{ id: 'res-b', reason: 'x' }] })
    const search = searchWith()

    await expect(
      reanalyseSearchIndex(dbWith([], ['res-a', 'res-b']), search, queue, log)
    ).rejects.toThrow('requeue')
    // Not recorded as done, so the next delivery finds the same window
    expect(search.markRepaired).not.toHaveBeenCalled()
  })

  it('asks for nothing when no content was written during the copy', async () => {
    await reanalyseSearchIndex(dbWith([]), searchWith(), queue, log)

    expect(markContentUnindexed).not.toHaveBeenCalled()
    expect(enqueueMany).not.toHaveBeenCalled()
  })

  it('does not copy the catalogue again when a redelivered message arrives', async () => {
    const search = searchWith({ analysisStale: vi.fn().mockResolvedValue(false) })

    const result = await reanalyseSearchIndex(dbWith([]), search, queue, log)

    expect(search.reanalyseIndex).not.toHaveBeenCalled()
    expect(result).toBeNull()
    expect(rebuildMetadataIndex).toHaveBeenCalled()
  })

  it('fails rather than acknowledge a re-analysis it could not even judge', async () => {
    const search = searchWith({
      analysisStale: vi.fn().mockRejectedValue(new Error('connection refused')),
    })

    await expect(reanalyseSearchIndex(dbWith([]), search, queue, log)).rejects.toThrow(
      'connection refused'
    )
    expect(rebuildMetadataIndex).not.toHaveBeenCalled()
  })

  it('leaves the message to fail when the copy does, rather than repair over it', async () => {
    const search = searchWith({
      reanalyseIndex: vi.fn().mockRejectedValue(new Error('copy lost documents')),
    })

    await expect(reanalyseSearchIndex(dbWith([]), search, queue, log)).rejects.toThrow('copy lost')
    expect(rebuildMetadataIndex).not.toHaveBeenCalled()
  })

  it('does nothing where the deployment has no search backend', async () => {
    expect(await reanalyseSearchIndex(dbWith([]), undefined, queue, log)).toBeNull()
    expect(rebuildMetadataIndex).not.toHaveBeenCalled()
  })
})
