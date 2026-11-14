/**
 * Tables profiled under another vocabulary registry state are read again
 * (ADR-073 §決定 4).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { job, packageTable, resource, resourcePipeline } from '@kukan/db'
import { PostgresJobQueue } from '@kukan/queue'
import { PIPELINE_JOB_TYPE, type TableProfile } from '@kukan/shared'
import { requestVocabularyRefresh } from '../../services/pipeline/vocabulary-refresh'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const queue = new PostgresJobQueue({ db })

const COLUMN: TableProfile['columns'][number] = { role: 'category', roleBasis: { rule: 'other' } }
const NOW = 'rules@1;JP@new'

async function seed(
  opts: {
    registry?: string
    columns?: number
    storageKey?: string | null
    state?: string
    packageState?: string
  } = {}
) {
  const [pkg] = await db
    .insert(packageTable)
    .values({ name: `pkg-${crypto.randomUUID()}`, state: opts.packageState ?? 'active' })
    .returning({ id: packageTable.id })
  const [row] = await db
    .insert(resource)
    .values({
      packageId: pkg.id,
      name: 'r',
      format: 'CSV',
      state: opts.state ?? 'active',
      storageKey: opts.storageKey === undefined ? 'resources/x' : opts.storageKey,
    })
    .returning({ id: resource.id })
  await db.insert(resourcePipeline).values({
    resourceId: row.id,
    profile: {
      columns: Array.from({ length: opts.columns ?? 1 }, () => COLUMN),
      ...(opts.registry !== undefined && { registry: opts.registry }),
    },
  })
  return row.id
}

const queued = async () =>
  (await db.select({ payload: job.payload }).from(job).where(eq(job.type, PIPELINE_JOB_TYPE))).map(
    (j) => j.payload as { resourceId: string; rebuildOnly?: boolean }
  )

beforeEach(async () => {
  await cleanDatabase()
})

afterAll(async () => {
  await closeTestDb()
})

describe('requestVocabularyRefresh', () => {
  it('reads again the tables profiled under another state, or under none', async () => {
    await seed({ registry: NOW })
    const old = await seed({ registry: 'rules@1;JP@old' })
    const never = await seed()

    expect(await requestVocabularyRefresh(db, queue, NOW)).toEqual({ enqueued: 2 })
    expect((await queued()).map((p) => p.resourceId).sort()).toEqual([old, never].sort())
    expect((await queued()).every((p) => p.rebuildOnly)).toBe(true)
  })

  it('reads again only the tables holding a vocabulary once every pack is off', async () => {
    const read = await seed({ registry: NOW })
    await seed()

    expect(await requestVocabularyRefresh(db, queue, null)).toEqual({ enqueued: 1 })
    expect((await queued()).map((p) => p.resourceId)).toEqual([read])
  })

  it('leaves what a rebuild could not reach, and what has no table', async () => {
    await seed({ state: 'deleted' })
    await seed({ packageState: 'deleted' })
    await seed({ storageKey: null })
    await seed({ columns: 0 })

    expect(await requestVocabularyRefresh(db, queue, NOW)).toEqual({ enqueued: 0 })
  })
})
