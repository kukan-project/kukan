import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LakeConfig } from '@kukan/lake'
import { LAKE_ORPHAN_RETENTION_MS } from '../config'

const deleteOrphanedFiles = vi.fn()
vi.mock('@kukan/lake', () => ({
  deleteOrphanedFiles: (...args: unknown[]) => deleteOrphanedFiles(...args),
  // The session is irrelevant here; what matters is the window passed through.
  withLakeSession: (_config: unknown, fn: (session: unknown) => Promise<unknown>) => fn({}),
}))

const { sweepLakeOrphans } = await import('../cron/orphan-cleanup/sweep-lake-orphans')

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
const lake = { bucket: 'b', region: 'r', pgConnString: '', s3UseSsl: false } as LakeConfig

beforeEach(() => {
  vi.clearAllMocks()
  deleteOrphanedFiles.mockResolvedValue([])
})

describe('sweepLakeOrphans', () => {
  it('spares files younger than the retention window', async () => {
    // The window is what keeps a Parquet that has been written but not yet
    // committed from being read as an orphan — it is live data.
    const before = Date.now()
    await sweepLakeOrphans(lake, log)

    const olderThan = deleteOrphanedFiles.mock.calls[0][1] as Date
    expect(olderThan.getTime()).toBeLessThanOrEqual(before - LAKE_ORPHAN_RETENTION_MS)
    expect(olderThan.getTime()).toBeGreaterThan(before - LAKE_ORPHAN_RETENTION_MS - 60_000)
  })

  it('deletes rather than reporting what it would delete', async () => {
    // A dry run here would leave the leak in place while looking like it swept.
    await sweepLakeOrphans(lake, log)

    expect(deleteOrphanedFiles.mock.calls[0][2]).toBeFalsy()
  })

  it('reports what it removed, with the paths', async () => {
    // An orphan means a run died mid-write, so a rising count is worth seeing.
    deleteOrphanedFiles.mockResolvedValue(['lake/main/t/a.parquet', 'lake/main/t/b.parquet'])

    expect(await sweepLakeOrphans(lake, log)).toEqual({ deleted: 2 })
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        deleted: 2,
        paths: expect.arrayContaining(['lake/main/t/a.parquet']),
      }),
      expect.any(String)
    )
  })

  it('stays quiet when there was nothing to sweep', async () => {
    expect(await sweepLakeOrphans(lake, log)).toEqual({ deleted: 0 })
    expect(log.info).not.toHaveBeenCalled()
  })

  it('does nothing without a lake configured', async () => {
    expect(await sweepLakeOrphans(undefined, log)).toEqual({ deleted: 0 })
    expect(deleteOrphanedFiles).not.toHaveBeenCalled()
  })
})
