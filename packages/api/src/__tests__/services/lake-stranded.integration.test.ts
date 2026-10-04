/**
 * Picking up a purged dataset's DuckLake tables whose drop job was lost —
 * against real PostgreSQL, with the catalog's table list stubbed.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { job, packageTable, resource } from '@kukan/db'
import { lakeTableName, withLakeSession } from '@kukan/lake'
import type { LakeSession } from '@kukan/lake'
import { PostgresJobQueue } from '@kukan/queue'
import { DROP_LAKE_TABLES_JOB_TYPE } from '@kukan/shared'
import { queueStrandedLakeTables } from '../../services/lake-reclaim'
import { unreachableLake } from '../test-helpers/fixtures'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'
import { queuedLakeDrops } from '../test-helpers/lake-drops'

vi.mock('@kukan/lake', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kukan/lake')>()
  return { ...actual, withLakeSession: vi.fn() }
})

const db = getTestDb()
const queue = new PostgresJobQueue({ db })

/** The catalog holds a table for each of these resources, and one of its own. */
function catalogHolds(resourceIds: string[]) {
  const rows = [...resourceIds.map(lakeTableName), 'ducklake_metadata'].map((table_name) => ({
    table_name,
  }))
  vi.mocked(withLakeSession).mockImplementation(async (_lake, fn) =>
    fn({ rows: async () => rows } as unknown as LakeSession, 1)
  )
}

async function liveResource(): Promise<string> {
  const [pkg] = await db
    .insert(packageTable)
    .values({ name: `p-${randomUUID()}`, state: 'active' })
    .returning()
  const [res] = await db
    .insert(resource)
    .values({ packageId: pkg.id, name: 'r', urlType: 'upload' })
    .returning()
  return res.id
}

beforeEach(async () => {
  await cleanDatabase()
  vi.mocked(withLakeSession).mockReset()
})

afterAll(async () => {
  await closeTestDb()
})

describe('queueStrandedLakeTables', () => {
  it('queues the drop of tables whose resource is gone, and no other', async () => {
    const live = await liveResource()
    const gone = randomUUID()
    catalogHolds([live, gone])

    expect(await queueStrandedLakeTables(db, queue, unreachableLake)).toEqual({ queued: 1 })
    expect(await queuedLakeDrops()).toEqual([{ resourceIds: [gone] }])
  })

  it('leaves alone a table a job already stands behind, dead ones included', async () => {
    const waiting = randomUUID()
    const dead = randomUUID()
    catalogHolds([waiting, dead])
    await queue.enqueue(DROP_LAKE_TABLES_JOB_TYPE, { resourceIds: [waiting] })
    const deadId = await queue.enqueue(DROP_LAKE_TABLES_JOB_TYPE, { resourceIds: [dead] })
    await db.update(job).set({ state: 'dead' }).where(eq(job.id, deadId))

    expect(await queueStrandedLakeTables(db, queue, unreachableLake)).toEqual({ queued: 0 })
    expect(await queuedLakeDrops()).toHaveLength(2)
  })

  it('queues one drop however many tasks look at once', async () => {
    const gone = randomUUID()
    catalogHolds([gone])

    await Promise.all([1, 2, 3].map(() => queueStrandedLakeTables(db, queue, unreachableLake)))

    expect(await queuedLakeDrops()).toEqual([{ resourceIds: [gone] }])
  })

  it('opens no session without a lake', async () => {
    expect(await queueStrandedLakeTables(db, queue, undefined)).toEqual({ queued: 0 })
    expect(withLakeSession).not.toHaveBeenCalled()
  })
})
