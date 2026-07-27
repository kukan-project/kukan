import { describe, it, expect } from 'vitest'
import type { LakeSession } from '../connection'
import { reclaimUnreferencedSnapshots } from '../maintenance'

/** Records the statements issued and answers the snapshot listing. */
function fakeSession(snapshots: number[]) {
  const statements: string[] = []
  const session: LakeSession = {
    run: async (sql) => {
      statements.push(sql)
    },
    rows: async (sql) => {
      statements.push(sql)
      if (sql.includes('ducklake_snapshots'))
        return snapshots.map((snapshot_id) => ({ snapshot_id }))
      // cleanup_old_files returns one row per deleted file.
      return [{ path: 'a.parquet' }, { path: 'b.parquet' }]
    },
    interrupt: () => {},
    close: async () => {},
  }
  return { session, statements }
}

const expireOf = (statements: string[]) => statements.find((s) => s.includes('expire_snapshots'))

describe('reclaimUnreferencedSnapshots', () => {
  it('expires the snapshots no version references', async () => {
    const { session, statements } = fakeSession([1, 2, 3, 4, 5])
    const result = await reclaimUnreferencedSnapshots(session, [2, 4])

    expect(expireOf(statements)).toContain('versions => [1,3]')
    expect(result).toEqual({ expired: 2, filesDeleted: 2 })
  })

  it('never expires the newest snapshot', async () => {
    // A purge that rolled a table back has just created one that no version row
    // points at; expiring it would drop what the tables currently read as.
    const { session, statements } = fakeSession([1, 2, 3])
    const result = await reclaimUnreferencedSnapshots(session, [])

    expect(expireOf(statements)).toContain('versions => [1,2]')
    expect(result.expired).toBe(2)
  })

  it('skips the expire when everything is still referenced', async () => {
    const { session, statements } = fakeSession([1, 2])
    const result = await reclaimUnreferencedSnapshots(session, [1, 2])

    expect(expireOf(statements)).toBeUndefined()
    expect(result.expired).toBe(0)
    // Cleanup still runs: an earlier purge may have left files behind.
    expect(statements.some((s) => s.includes('cleanup_old_files'))).toBe(true)
  })

  it('cuts off in-flight readers rather than waiting for them', async () => {
    const { session, statements } = fakeSession([1, 2])
    await reclaimUnreferencedSnapshots(session, [2])

    expect(statements.find((s) => s.includes('cleanup_old_files'))).toContain('cleanup_all => true')
  })

  it('does nothing on an empty catalog', async () => {
    const { session, statements } = fakeSession([])
    const result = await reclaimUnreferencedSnapshots(session, [])

    expect(result).toEqual({ expired: 0, filesDeleted: 0 })
    expect(statements.some((s) => s.includes('cleanup_old_files'))).toBe(false)
  })
})
