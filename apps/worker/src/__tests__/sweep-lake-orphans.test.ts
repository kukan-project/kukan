import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LakeConfig } from '@kukan/lake'
import type { Logger } from '@kukan/shared'
import { LAKE_ORPHAN_RETENTION_MS } from '../config'

const deleteOrphanedFiles = vi.fn()
const withLakeSession = vi.fn(
  (
    _config: unknown,
    fn: (session: unknown, attempt: number) => Promise<unknown>,
    _options?: unknown
  ) => fn({}, 1)
)
vi.mock('@kukan/lake', () => ({
  deleteOrphanedFiles: (...args: unknown[]) => deleteOrphanedFiles(...args),
  // The session is irrelevant here; what matters is the window passed through.
  withLakeSession: (...args: Parameters<typeof withLakeSession>) => withLakeSession(...args),
}))

const { sweepLakeOrphans } = await import('../cron/orphan-cleanup/sweep-lake-orphans')

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
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
    const after = Date.now()

    // The cutoff is a whole retention behind whenever the sweep read the clock,
    // so it lands inside the interval the call spanned — bounded from both
    // sides rather than against one reading, which only holds if the two land
    // in the same millisecond.
    const olderThan = deleteOrphanedFiles.mock.calls[0][1] as Date
    expect(olderThan.getTime()).toBeGreaterThanOrEqual(before - LAKE_ORPHAN_RETENTION_MS)
    expect(olderThan.getTime()).toBeLessThanOrEqual(after - LAKE_ORPHAN_RETENTION_MS)
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

  it('asks for the work to be rerun when the instance was lost', async () => {
    // The tick that lands on a credential rotation used to fail whole.
    await sweepLakeOrphans(lake, log)

    expect(withLakeSession.mock.calls[0][2]).toEqual({ rerunIfLost: true })
  })

  it("says so when the count is a rerun's, even when that count is zero", async () => {
    // The first pass may have deleted everything before the instance was lost;
    // a silent zero would hide the one tick whose orphans went unobserved.
    withLakeSession.mockImplementationOnce((_config, fn) => fn({}, 2))

    expect(await sweepLakeOrphans(lake, log)).toEqual({ deleted: 0 })
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: 0 }),
      expect.stringMatching(/rebuilt instance/)
    )
    expect(log.info).not.toHaveBeenCalled()
  })

  it('does nothing without a lake configured', async () => {
    expect(await sweepLakeOrphans(undefined, log)).toEqual({ deleted: 0 })
    expect(deleteOrphanedFiles).not.toHaveBeenCalled()
  })
})
