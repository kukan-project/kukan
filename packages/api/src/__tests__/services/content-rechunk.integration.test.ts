/**
 * Content cut under a larger chunk size than the one in force is indexed again,
 * from the object each resource holds, and never twice for one resource.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { job, packageTable, resource, resourcePipeline } from '@kukan/db'
import type { SearchAdapter } from '@kukan/search-adapter'
import { PostgresJobQueue } from '@kukan/queue'
import { MAX_CONTENT_CHUNK_SIZE, PIPELINE_JOB_TYPE } from '@kukan/shared'
import { requestContentRechunk } from '../../services/search/content-rechunk'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from '@kukan/db/schema'
import { getTestDb, getTestDatabaseUrl, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const queue = new PostgresJobQueue({ db })

/** An index whose chunked-above listing holds `ids` */
function chunkedIndex(ids: string[]) {
  return {
    indexedContentResources: vi.fn(async (after?: string, limit = 1_000, filter?) => {
      if (filter?.chunkedAbove !== MAX_CONTENT_CHUNK_SIZE) return []
      const from = after === undefined ? 0 : ids.indexOf(after) + 1
      return ids.slice(from, from + limit)
    }),
    deleteContent: vi.fn(async () => {}),
  } satisfies Partial<SearchAdapter> as unknown as SearchAdapter & {
    deleteContent: ReturnType<typeof vi.fn>
  }
}

async function seed(
  opts: { storageKey?: string | null; state?: string; packageState?: string } = {}
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
      format: 'PDF',
      state: opts.state ?? 'active',
      storageKey: opts.storageKey === undefined ? 'resources/x' : opts.storageKey,
    })
    .returning({ id: resource.id })
  return row.id
}

const queuedRuns = async () =>
  (await db.select({ payload: job.payload }).from(job).where(eq(job.type, PIPELINE_JOB_TYPE))).map(
    (j) => j.payload
  )

beforeEach(async () => {
  await cleanDatabase()
})

afterAll(async () => {
  await closeTestDb()
})

describe('requestContentRechunk', () => {
  it('rebuilds each from its stored object', async () => {
    const id = await seed()

    const result = await requestContentRechunk(db, chunkedIndex([id]), queue)

    expect(result).toEqual({ enqueued: 1, dropped: 0 })
    expect(await queuedRuns()).toEqual([
      expect.objectContaining({ resourceId: id, rebuildOnly: true }),
    ])
  })

  it('drops the content no run would replace, and says the rows hold none', async () => {
    const deleted = await seed({ state: 'deleted' })
    const draft = await seed({ packageState: 'draft' })
    const unstored = await seed({ storageKey: null })
    const gone = crypto.randomUUID()
    const search = chunkedIndex([deleted, draft, unstored, gone, 'not-a-uuid'])
    await db
      .insert(resourcePipeline)
      .values({ resourceId: draft, status: 'complete', metadata: { contentIndexed: true } })

    const result = await requestContentRechunk(db, search, queue)

    expect(result).toEqual({ enqueued: 0, dropped: 5 })
    expect(await queuedRuns()).toEqual([])
    for (const id of [deleted, draft, unstored, gone, 'not-a-uuid']) {
      expect(search.deleteContent).toHaveBeenCalledWith(id)
    }
    const [row] = await db
      .select({ metadata: resourcePipeline.metadata })
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, draft))
    expect(row.metadata).toMatchObject({ contentIndexed: false })
  })

  it('leaves a resource to a rebuild on its way, waiting or running, and to nothing else', async () => {
    const waiting = await seed()
    const running = await seed()
    const ordinary = await seed()
    await queue.enqueue(PIPELINE_JOB_TYPE, { resourceId: waiting, rebuildOnly: true })
    await queue.enqueue(PIPELINE_JOB_TYPE, { resourceId: running, rebuildOnly: true })
    await db
      .update(job)
      .set({ lockedUntil: sql`now() + interval '1 minute'` })
      .where(sql`${job.payload} ->> 'resourceId' = ${running}`)
    // An ordinary run may find its derivatives current and skip Index
    await queue.enqueue(PIPELINE_JOB_TYPE, { resourceId: ordinary })

    const result = await requestContentRechunk(
      db,
      chunkedIndex([waiting, running, ordinary]),
      queue
    )

    expect(result).toEqual({ enqueued: 1, dropped: 0 })
    expect(await queuedRuns()).toContainEqual(
      expect.objectContaining({ resourceId: ordinary, rebuildOnly: true })
    )
  })

  it('gets through on a pool of one connection', async () => {
    const id = await seed()
    // A pass that held one connection and asked for another would wait out the timeout
    const pool = new Pool({
      connectionString: getTestDatabaseUrl(),
      max: 1,
      connectionTimeoutMillis: 2_000,
    })
    const single = drizzle(pool, { schema })
    try {
      const result = await requestContentRechunk(
        single,
        chunkedIndex([id, crypto.randomUUID()]),
        new PostgresJobQueue({ db: single })
      )
      expect(result).toEqual({ enqueued: 1, dropped: 1 })
    } finally {
      await pool.end()
    }
  })

  it('queues each resource once when two passes run at the same time', async () => {
    const ids = await Promise.all([seed(), seed(), seed()])
    const search = chunkedIndex(ids)

    const results = await Promise.all([
      requestContentRechunk(db, search, queue),
      requestContentRechunk(db, search, queue),
    ])

    expect(results.reduce((n, r) => n + r.enqueued, 0)).toBe(3)
    expect(await queuedRuns()).toHaveLength(3)
  })

  it('adds nothing on a second press while the first one’s runs wait', async () => {
    const id = await seed()
    const search = chunkedIndex([id])

    await requestContentRechunk(db, search, queue)
    expect(await requestContentRechunk(db, search, queue)).toEqual({
      enqueued: 0,
      dropped: 0,
    })
    expect(await queuedRuns()).toHaveLength(1)
  })
})
