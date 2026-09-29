import { describe, it, expect, vi } from 'vitest'
import { purgePackageExternals } from '../../services/package-cleanup'

/** A database whose transactions run at once: the lock is the sync's, not under test here */
const db = {
  transaction: (fn: (tx: unknown) => unknown) => fn({ execute: vi.fn() }),
} as never

describe('purgePackageExternals', () => {
  it('deletes the search docs and every storage prefix', async () => {
    const search = { deletePackage: vi.fn().mockResolvedValue(undefined) }
    const storage = { deleteByPrefix: vi.fn().mockResolvedValue(0) }

    await purgePackageExternals(db, 'pkg-1', { search: search as never, storage: storage as never })

    expect(search.deletePackage).toHaveBeenCalledWith('pkg-1')
    expect(storage.deleteByPrefix).toHaveBeenCalledWith('resources/pkg-1/')
    expect(storage.deleteByPrefix).toHaveBeenCalledWith('previews/pkg-1/')
  })

  it('skips search cleanup when search is undefined but still clears storage', async () => {
    const storage = { deleteByPrefix: vi.fn().mockResolvedValue(0) }

    await purgePackageExternals(db, 'pkg-1', { storage: storage as never })

    expect(storage.deleteByPrefix).toHaveBeenCalledTimes(2)
  })
})
