/**
 * The layer 2 half of the pipeline's context (ADR-067): what an ingest that
 * cannot simply add to the resource's catalog asks of the queue.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Database } from '@kukan/db'
import type { LakeConfig } from '@kukan/lake'
import type { JobQueue } from '@kukan/queue'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { buildPipelineContext } from '../../../pipeline/run/build-context'

const lake = vi.hoisted(() => ({
  needsRebuild: false,
  ingest: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ snapshotId: 7 })),
}))

vi.mock('@kukan/api/services/lake/lake-rebuild', () => ({
  lakeNeedsRebuild: vi.fn(async () => lake.needsRebuild),
  queueLakeRebuild: vi.fn(async (queue: { enqueue: (...a: unknown[]) => unknown }, id: string) =>
    queue.enqueue('rebuild-lake-catalog', { resourceId: id }, { unlessWaiting: true })
  ),
}))
vi.mock('@kukan/api/services/lake/lake-catalog', () => ({
  ingestVersionIntoResourceCatalog: lake.ingest,
}))

const row = { resourceId: 'res-1', version: 2, sourcePath: '/tmp/v.parquet' }
let queue: { enqueue: ReturnType<typeof vi.fn> }

function ingest() {
  return buildPipelineContext({} as Database, {} as StorageAdapter, undefined, {
    config: {} as LakeConfig,
    queue: queue as unknown as Pick<JobQueue, 'enqueue'>,
  }).ingestLakeVersion(row)
}

beforeEach(() => {
  vi.clearAllMocks()
  lake.needsRebuild = false
  lake.ingest.mockResolvedValue({ snapshotId: 7 })
  queue = { enqueue: vi.fn().mockResolvedValue('job-1') }
})

describe('ingestLakeVersion', () => {
  it('loads the version and asks the queue for nothing', async () => {
    expect(await ingest()).toEqual({ snapshotId: 7 })
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('queues a rebuild of a resource still in the shared catalog, and loads nothing', async () => {
    // A rebuild interprets every other version, and this runs inside an
    // interpretation: its own job, which loads this version with the rest
    lake.needsRebuild = true

    expect(await ingest()).toBeNull()
    expect(lake.ingest).not.toHaveBeenCalled()
    expect(queue.enqueue).toHaveBeenCalledWith(
      'rebuild-lake-catalog',
      { resourceId: 'res-1' },
      { unlessWaiting: true }
    )
  })

  it('queues the clearing of what an earlier attempt left, when the load could not', async () => {
    lake.ingest.mockResolvedValue({ snapshotId: 7, uncleared: true })

    expect(await ingest()).toMatchObject({ snapshotId: 7 })
    expect(queue.enqueue).toHaveBeenCalledWith(
      'rebuild-lake-catalog',
      { resourceId: 'res-1' },
      { unlessWaiting: true }
    )
  })
})
