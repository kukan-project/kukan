/**
 * The sweep that comes back for content documents a failed write left
 * disagreeing with their rows: a run for what a run would index again, a
 * removal for the rest, and the mark lowered only where it is still the one
 * read.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { job, packageTable, resource, resourcePipeline } from '@kukan/db'
import type { SearchAdapter } from '@kukan/search-adapter'
import { PostgresJobQueue } from '@kukan/queue'
import { PIPELINE_JOB_TYPE } from '@kukan/shared'
import { sweepContentIndexMarks } from '../../services/search/content-index-sweep'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const queue = new PostgresJobQueue({ db })
const opts = { minAgeMs: 10 * 60_000 }

function contentIndex(deleteContent: (id: string) => Promise<void> = async () => {}) {
  return {
    deleteContent: vi.fn(deleteContent),
  } satisfies Partial<SearchAdapter> as unknown as SearchAdapter & {
    deleteContent: ReturnType<typeof vi.fn>
  }
}

/** A resource whose content index mark was raised an hour ago, unless `due` says otherwise */
async function seed(
  opts: {
    storageKey?: string | null
    state?: string
    packageState?: string
    format?: string
    due?: ReturnType<typeof sql> | null
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
      format: opts.format ?? 'PDF',
      state: opts.state ?? 'active',
      storageKey: opts.storageKey === undefined ? 'resources/x' : opts.storageKey,
      contentIndexDueAt: opts.due === undefined ? sql`NOW() - INTERVAL '1 hour'` : opts.due,
    })
    .returning({ id: resource.id })
  await db
    .insert(resourcePipeline)
    .values({ resourceId: row.id, status: 'complete', metadata: { contentIndexed: true } })
  return row.id
}

async function mark(id: string) {
  const [row] = await db
    .select({ dueAt: resource.contentIndexDueAt })
    .from(resource)
    .where(eq(resource.id, id))
  return row.dueAt
}

const queuedRuns = async () =>
  db
    .select({ payload: job.payload, priority: job.priority })
    .from(job)
    .where(eq(job.type, PIPELINE_JOB_TYPE))

beforeEach(async () => {
  await cleanDatabase()
})

afterAll(async () => {
  await closeTestDb()
})

describe('sweepContentIndexMarks', () => {
  it('queues an index-only run for a resource a run would index, and leaves the mark to it', async () => {
    const id = await seed()
    const search = contentIndex()

    expect(await sweepContentIndexMarks(db, search, queue, opts)).toEqual({
      queued: 1,
      failed: 0,
      removed: 0,
      held: 0,
    })
    expect(await queuedRuns()).toEqual([
      { payload: expect.objectContaining({ resourceId: id, indexOnly: true }), priority: 'low' },
    ])
    expect(search.deleteContent).not.toHaveBeenCalled()
    // Stamped afresh: a run that never reaches its Index step goes to the back
    const stamped = await mark(id)
    expect(stamped!.getTime()).toBeGreaterThan(Date.now() - 60_000)

    // The run now waiting stands behind the mark
    expect(await sweepContentIndexMarks(db, search, queue, opts)).toEqual({
      queued: 0,
      failed: 0,
      removed: 0,
      held: 0,
    })
    expect(await queuedRuns()).toHaveLength(1)
  })

  it('leaves a resource with a run already waiting to that run', async () => {
    const id = await seed({ state: 'deleted' })
    await queue.enqueue(PIPELINE_JOB_TYPE, { resourceId: id })
    const search = contentIndex()

    expect(await sweepContentIndexMarks(db, search, queue, opts)).toEqual({
      queued: 0,
      failed: 0,
      removed: 0,
      held: 0,
    })
    expect(search.deleteContent).not.toHaveBeenCalled()
    expect(await mark(id)).not.toBeNull()
  })

  it('removes the content of every resource no run would index, and lowers its mark', async () => {
    const deleted = await seed({ state: 'deleted' })
    const draft = await seed({ packageState: 'draft' })
    const trashed = await seed({ packageState: 'deleted' })
    const unfetched = await seed({ storageKey: null })
    const image = await seed({ format: 'PNG' })
    const search = contentIndex()

    expect(await sweepContentIndexMarks(db, search, queue, opts)).toEqual({
      queued: 0,
      failed: 0,
      removed: 5,
      held: 0,
    })
    for (const id of [deleted, draft, trashed, unfetched, image]) {
      expect(search.deleteContent).toHaveBeenCalledWith(id)
      expect(await mark(id)).toBeNull()
    }
    // A later run must not read the removed content as still indexed
    const rows = await db.select({ metadata: resourcePipeline.metadata }).from(resourcePipeline)
    expect(
      rows.every((r) => (r.metadata as { contentIndexed?: boolean }).contentIndexed === false)
    ).toBe(true)
    expect(await queuedRuns()).toEqual([])
  })

  it('keeps a mark raised while the content was being removed', async () => {
    const id = await seed({ state: 'deleted' })
    const search = contentIndex(async () => {
      await db
        .update(resource)
        .set({ contentIndexDueAt: sql`NOW()` })
        .where(eq(resource.id, id))
    })

    expect((await sweepContentIndexMarks(db, search, queue, opts)).removed).toBe(1)

    expect(await mark(id)).not.toBeNull()
  })

  it('leaves the mark when the index refuses the removal', async () => {
    const id = await seed({ state: 'deleted' })
    const search = contentIndex(async () => {
      throw new Error('search unavailable')
    })

    await expect(sweepContentIndexMarks(db, search, queue, opts)).rejects.toThrow(
      'search unavailable'
    )

    expect(await mark(id)).not.toBeNull()
  })

  it('leaves a mark raised moments ago to whatever raised it', async () => {
    const id = await seed({ state: 'deleted', due: sql`NOW()` })
    const search = contentIndex()

    expect((await sweepContentIndexMarks(db, search, queue, opts)).removed).toBe(0)
    expect(await mark(id)).not.toBeNull()

    // After a worker start the grace period is waived
    expect((await sweepContentIndexMarks(db, search, queue, { minAgeMs: 0 })).removed).toBe(1)
  })

  it('leaves a resource a run holds for the next pass', async () => {
    const id = await seed({ state: 'deleted' })
    await db
      .update(resourcePipeline)
      .set({ claimOwner: crypto.randomUUID(), claimOwnerAt: sql`NOW()`, claimKind: 'run' })
      .where(eq(resourcePipeline.resourceId, id))
    const search = contentIndex()

    expect(await sweepContentIndexMarks(db, search, queue, opts)).toEqual({
      queued: 0,
      failed: 0,
      removed: 0,
      held: 1,
    })
    expect(search.deleteContent).not.toHaveBeenCalled()
    expect(await mark(id)).not.toBeNull()
  })

  it('ignores a resource with no mark', async () => {
    await seed({ state: 'deleted', due: null })
    const search = contentIndex()

    expect(await sweepContentIndexMarks(db, search, queue, opts)).toEqual({
      queued: 0,
      failed: 0,
      removed: 0,
      held: 0,
    })
  })
})
