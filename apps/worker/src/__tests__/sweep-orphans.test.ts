import { describe, it, expect, vi } from 'vitest'
import { sweepOrphanedObjects } from '../cron/orphan-cleanup/sweep-orphans'
import type { Database } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { Logger } from '@kukan/shared'

/** Every string bound into a drizzle condition tree (which is cyclic). */
function boundStrings(node: unknown, found: string[] = [], seen = new WeakSet<object>()): string[] {
  if (typeof node === 'string') found.push(node)
  else if (node && typeof node === 'object') {
    if (seen.has(node)) return found
    seen.add(node)
    Object.values(node).forEach((n) => boundStrings(n, found, seen))
  }
  return found
}

/** Chainable stub: the SELECT resolves to `due`, the DELETE records its filter. */
function createDb(due: string[]) {
  const untracked: string[][] = []
  const select = {
    from: () => select,
    where: () => select,
    orderBy: () => select,
    limit: () => Promise.resolve(due.map((key) => ({ key }))),
  }
  const db = {
    select: () => select,
    delete: () => ({
      where: (cond: unknown) => {
        untracked.push(boundStrings(cond))
        return Promise.resolve()
      },
    }),
  }
  return { db: db as unknown as Database, untracked }
}

const log = { info: vi.fn() } as unknown as Logger

describe('sweepOrphanedObjects', () => {
  it('does nothing when no key has passed its retention', async () => {
    const { db, untracked } = createDb([])
    const storage = { deleteMany: vi.fn() } as unknown as StorageAdapter

    expect(await sweepOrphanedObjects(db, storage, log)).toEqual({ scanned: 0, deleted: 0 })
    expect(storage.deleteMany).not.toHaveBeenCalled()
    expect(untracked).toHaveLength(0)
  })

  it('deletes every due key in one batch and stops tracking them', async () => {
    const { db, untracked } = createDb(['a', 'b'])
    const storage = {
      deleteMany: vi.fn().mockResolvedValue(['a', 'b']),
    } as unknown as StorageAdapter

    expect(await sweepOrphanedObjects(db, storage, log)).toEqual({ scanned: 2, deleted: 2 })
    // One call, not one per key — the sweep is the reason deleteMany exists.
    expect(storage.deleteMany).toHaveBeenCalledTimes(1)
    expect(storage.deleteMany).toHaveBeenCalledWith(['a', 'b'])
    expect(untracked).toHaveLength(1)
  })

  it('keeps a key whose delete failed parked for the next sweep', async () => {
    // Untracking it would turn a transient storage error into an object nothing
    // knows about — the one outcome this table exists to prevent.
    const { db, untracked } = createDb(['ok', 'broken'])
    const storage = { deleteMany: vi.fn().mockResolvedValue(['ok']) } as unknown as StorageAdapter

    expect(await sweepOrphanedObjects(db, storage, log)).toEqual({ scanned: 2, deleted: 1 })
    expect(untracked[0]).toContain('ok')
    expect(untracked[0]).not.toContain('broken')
  })
})
