import { describe, it, expect, vi } from 'vitest'
import { purgePackageExternals } from '../../services/package-cleanup'

describe('purgePackageExternals', () => {
  it('deletes the search docs and both storage prefixes', async () => {
    const search = { deletePackage: vi.fn().mockResolvedValue(undefined) }
    const storage = { deleteByPrefix: vi.fn().mockResolvedValue(0) }

    await purgePackageExternals('pkg-1', search as never, storage as never)

    expect(search.deletePackage).toHaveBeenCalledWith('pkg-1')
    expect(storage.deleteByPrefix).toHaveBeenCalledWith('resources/pkg-1/')
    expect(storage.deleteByPrefix).toHaveBeenCalledWith('previews/pkg-1/')
  })

  it('skips search cleanup when search is undefined but still clears storage', async () => {
    const storage = { deleteByPrefix: vi.fn().mockResolvedValue(0) }

    await purgePackageExternals('pkg-1', undefined, storage as never)

    expect(storage.deleteByPrefix).toHaveBeenCalledTimes(2)
  })
})
