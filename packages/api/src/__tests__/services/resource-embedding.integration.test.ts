/**
 * Which writes mark a resource's vector stale, and the ask that follows
 * (ADR-054). A write that changes nothing the vector is built from marks
 * nothing, so it queues no job.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { organization, packageTable, resource } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'
import { EMBED_JOB_TYPE, createLogger } from '@kukan/shared'
import { PackageService } from '../../services/package-service'
import { ResourceService } from '../../services/resource-service'
import { setResourceSummary } from '../../services/resource-summary-service'
import {
  EMBED_DELAY_S,
  enqueueResourceEmbedsIfDue,
  markAllResourceEmbeddings,
} from '../../services/resource-embedding'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const logger = createLogger({ name: 'test', level: 'silent' })
const ai = { getEmbeddingInfo: () => ({ model: 'm', dimensions: 3 }) } as unknown as AIAdapter

/** An active dataset with two live, unmarked resources */
async function seed(state: 'active' | 'draft' | 'deleted' = 'active') {
  const [org] = await db
    .insert(organization)
    .values({ name: `org-${crypto.randomUUID()}` })
    .returning({ id: organization.id })
  const name = `pkg-${crypto.randomUUID()}`
  const [pkg] = await db
    .insert(packageTable)
    .values({ name, title: 'タイトル', state, ownerOrg: org.id, licenseId: 'cc-by' })
    .returning({ id: packageTable.id })
  const ids = []
  for (const [i, n] of ['a.csv', 'b.csv'].entries()) {
    const [row] = await db
      .insert(resource)
      .values({ packageId: pkg.id, name: n, position: i, state: 'active', summary: '抄録。' })
      .returning({ id: resource.id })
    ids.push(row.id)
  }
  return { packageId: pkg.id, name, ownerOrg: org.id, resourceIds: ids }
}

const due = async (id: string) =>
  (await db.select({ d: resource.embeddingDueAt }).from(resource).where(eq(resource.id, id)))[0].d

const clearMarks = () => db.update(resource).set({ embeddingDueAt: null })

beforeEach(async () => {
  await cleanDatabase()
})
afterAll(async () => {
  await closeTestDb()
})

describe('resource writes', () => {
  it('marks a created resource', async () => {
    const { packageId } = await seed()
    const [created] = await db.transaction((tx) =>
      new ResourceService(db).createMany(tx, packageId, [{ name: 'c.csv' }])
    )

    expect(await due(created.id)).not.toBeNull()
  })

  it.each([
    ['the name', { name: 'renamed.csv' }, true],
    ['the description', { name: 'a.csv', description: '説明' }, true],
    ['the section', { name: 'a.csv', section: '地区別' }, true],
    [
      'only the URL and format',
      { name: 'a.csv', url: 'https://example.com/a', format: 'CSV' },
      false,
    ],
  ])('an edit of %s marks it: %s', async (_, input, marked) => {
    const { resourceIds } = await seed()

    await new ResourceService(db).update(resourceIds[0], input)

    expect((await due(resourceIds[0])) !== null).toBe(marked)
  })

  it('a relabel marks the resources whose label moved, a reorder alone nothing', async () => {
    const { packageId, resourceIds } = await seed()
    const service = new ResourceService(db)

    await service.reorder(packageId, [...resourceIds].reverse())
    expect(await due(resourceIds[0])).toBeNull()

    await service.reorder(packageId, resourceIds, [
      { resourceId: resourceIds[0], section: '地区別' },
      { resourceId: resourceIds[1], section: null },
    ])
    expect(await due(resourceIds[0])).not.toBeNull()
    expect(await due(resourceIds[1])).toBeNull()
  })

  it('hiding the abstract marks it; hiding it again does not', async () => {
    const { resourceIds } = await seed()
    const [id] = resourceIds

    await setResourceSummary(db, id, { hidden: true })
    expect(await due(id)).not.toBeNull()

    await clearMarks()
    await setResourceSummary(db, id, { hidden: true })
    expect(await due(id)).toBeNull()
  })
})

describe('dataset writes', () => {
  const update = (
    s: Awaited<ReturnType<typeof seed>>,
    input: { title?: string; notes?: string; tags?: { name: string }[] }
  ) =>
    new PackageService(db).update(s.packageId, {
      name: s.name,
      ownerOrg: s.ownerOrg,
      title: 'タイトル',
      ...input,
    })

  it.each([
    ['the title', { title: '新しいタイトル' }, true],
    ['the tags', { tags: [{ name: '人口' }] }, true],
    ['only the notes', { notes: '説明文' }, false],
  ])('an edit of %s marks every live resource: %s', async (_, input, marked) => {
    const s = await seed()

    await update(s, input)

    for (const id of s.resourceIds) expect((await due(id)) !== null).toBe(marked)
  })

  it('the same tags sent again, in another order, mark nothing', async () => {
    const s = await seed()
    await update(s, { tags: [{ name: '人口' }, { name: '統計' }] })
    await clearMarks()

    await update(s, { tags: [{ name: '統計' }, { name: '人口' }] })

    expect(await due(s.resourceIds[0])).toBeNull()
  })

  it("a draft's edit marks nothing: publish marks them all", async () => {
    const s = await seed('draft')

    await update(s, { title: '新しいタイトル' })

    expect(await due(s.resourceIds[0])).toBeNull()
  })

  it.each([
    ['publishes', 'draft', (id: string) => new PackageService(db).publish(id)],
    ['restores', 'deleted', (id: string) => new PackageService(db).restore(id)],
  ] as const)(
    'marks the resources in the transaction that %s the dataset',
    async (_, state, go) => {
      const s = await seed(state)

      await go(s.packageId)

      for (const id of s.resourceIds) expect(await due(id)).not.toBeNull()
    }
  )

  it('a regenerate marks the live resources of live datasets only', async () => {
    const live = await seed()
    const draft = await seed('draft')
    await new ResourceService(db).delete(live.resourceIds[1])

    await markAllResourceEmbeddings(db)

    expect(await due(live.resourceIds[0])).not.toBeNull()
    expect(await due(live.resourceIds[1])).toBeNull()
    expect(await due(draft.resourceIds[0])).toBeNull()
  })
})

describe('enqueueResourceEmbedsIfDue', () => {
  function fakeQueue(enqueue = vi.fn().mockResolvedValue('job')) {
    return { queue: { enqueue } as unknown as QueueAdapter, enqueue }
  }

  it('asks for one delayed job when anything in its scope is marked', async () => {
    const { packageId, resourceIds } = await seed()
    await db
      .update(resource)
      .set({ embeddingDueAt: sql`NOW()` })
      .where(eq(resource.id, resourceIds[1]))
    const { queue, enqueue } = fakeQueue()

    await enqueueResourceEmbedsIfDue(db, { queue, ai, logger }, { resourceIds: [resourceIds[0]] })
    expect(enqueue).not.toHaveBeenCalled()

    await enqueueResourceEmbedsIfDue(db, { queue, ai, logger }, { packageId })
    expect(enqueue).toHaveBeenCalledWith(
      EMBED_JOB_TYPE,
      {},
      { delaySeconds: EMBED_DELAY_S, unlessWaiting: true }
    )
  })

  it('asks for nothing where embedding is unavailable', async () => {
    const { packageId } = await seed()
    await db.update(resource).set({ embeddingDueAt: sql`NOW()` })
    const { queue, enqueue } = fakeQueue()
    const off = { getEmbeddingInfo: () => null } as unknown as AIAdapter

    await enqueueResourceEmbedsIfDue(db, { queue, ai: off, logger }, { packageId })

    expect(enqueue).not.toHaveBeenCalled()
  })

  it('swallows a queue failure: the mark stays for the sweep', async () => {
    const { packageId } = await seed()
    await db.update(resource).set({ embeddingDueAt: sql`NOW()` })
    const { queue } = fakeQueue(vi.fn().mockRejectedValue(new Error('queue down')))

    await expect(
      enqueueResourceEmbedsIfDue(db, { queue, ai, logger }, { packageId })
    ).resolves.toBeUndefined()
  })
})
