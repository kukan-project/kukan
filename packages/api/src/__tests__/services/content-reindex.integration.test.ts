/**
 * Every resource's content is indexed again from its interpretation, and
 * content no run would replace is dropped.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { job, packageTable, resource, resourcePipeline } from '@kukan/db'
import type { SearchAdapter } from '@kukan/search-adapter'
import { PostgresJobQueue } from '@kukan/queue'
import { PIPELINE_JOB_TYPE } from '@kukan/shared'
import { requestContentReindex } from '../../services/search/content-reindex'
import { PipelineService } from '../../services/pipeline/pipeline-service'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const queue = new PostgresJobQueue({ db })

/** An index holding content for `ids` */
function contentIndex(ids: string[] = []) {
  return {
    indexedContentResources: vi.fn(async (after?: string, limit = 1_000) => {
      const from = after === undefined ? 0 : ids.indexOf(after) + 1
      return ids.slice(from, from + limit)
    }),
    deleteContent: vi.fn(async () => {}),
  } satisfies Partial<SearchAdapter> as unknown as SearchAdapter & {
    deleteContent: ReturnType<typeof vi.fn>
  }
}

async function seed(
  opts: { storageKey?: string | null; state?: string; packageState?: string; format?: string } = {}
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
      format: opts.format ?? 'PDF',
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

describe('requestContentReindex', () => {
  it('indexes again every resource a run would index, from its interpretation', async () => {
    const live = await seed()
    await seed({ state: 'deleted' })
    await seed({ packageState: 'draft' })
    await seed({ storageKey: null })
    await seed({ format: 'PNG' })

    expect(await requestContentReindex(db, contentIndex(), queue)).toEqual({
      enqueued: 1,
      dropped: 0,
    })
    expect(await queuedRuns()).toEqual([
      expect.objectContaining({ resourceId: live, indexOnly: true }),
    ])
  })

  it('leaves the content it will replace where it is until each run does', async () => {
    const id = await seed()
    await db
      .insert(resourcePipeline)
      .values({ resourceId: id, status: 'complete', metadata: { contentIndexed: true } })
    const search = contentIndex([id])

    await requestContentReindex(db, search, queue)

    expect(search.deleteContent).not.toHaveBeenCalled()
    const [row] = await db
      .select({ metadata: resourcePipeline.metadata })
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, id))
    expect(row.metadata).toMatchObject({ contentIndexed: true })
  })

  it('drops the content no run would replace, and says the rows hold none', async () => {
    const deleted = await seed({ state: 'deleted' })
    const draft = await seed({ packageState: 'draft' })
    const unstored = await seed({ storageKey: null })
    const image = await seed({ format: 'PNG' })
    const gone = crypto.randomUUID()
    const unreplaced = [deleted, draft, unstored, image, gone, 'not-a-uuid']
    const search = contentIndex(unreplaced)
    await db
      .insert(resourcePipeline)
      .values({ resourceId: draft, status: 'complete', metadata: { contentIndexed: true } })

    const result = await requestContentReindex(db, search, queue)

    expect(result).toEqual({ enqueued: 0, dropped: 6 })
    for (const id of unreplaced) expect(search.deleteContent).toHaveBeenCalledWith(id)
    const [row] = await db
      .select({ metadata: resourcePipeline.metadata })
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, draft))
    expect(row.metadata).toMatchObject({ contentIndexed: false })
  })

  it('fails, for the job to run again, when a batch could not be queued', async () => {
    await seed()
    await seed()
    vi.spyOn(PipelineService.prototype, 'enqueueMany').mockResolvedValueOnce({
      enqueued: 0,
      failed: [{ id: 'x', reason: new Error('connection reset') }],
    })

    await expect(requestContentReindex(db, contentIndex(), queue)).rejects.toThrow(
      'Could not queue 1 resources to index again'
    )
  })
})
