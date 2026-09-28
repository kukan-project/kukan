/**
 * The embed job: builds the vectors of the resources marked due, a batch to a
 * provider call, and clears each mark only if it is still the one it read
 * (ADR-054).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { packageTable, packageTag, resource, tag } from '@kukan/db'
import { AiInputRejectedError, type AIAdapter } from '@kukan/ai-adapter'
import { RESOURCE_EMBED_LOCK, tryLockInTransaction } from '@kukan/api/services/advisory-lock'
import { embedDueResources } from '../../embed/embed-resources'
import { EMBED_BATCH_SIZE } from '../../config'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const KEY = 'test-model@3'

function makeAi(embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [1, 2, 3]))) {
  const ai = {
    getEmbeddingInfo: () => ({ model: 'test-model', dimensions: 3 }),
    embedBatch,
  } as unknown as AIAdapter
  return { ai, embedBatch }
}

async function seedPackage(opts: { title?: string | null; state?: string; tags?: string[] } = {}) {
  const [pkg] = await db
    .insert(packageTable)
    .values({
      name: `pkg-${crypto.randomUUID()}`,
      title: opts.title === undefined ? 'タイトル' : opts.title,
      state: opts.state ?? 'active',
    })
    .returning({ id: packageTable.id })
  for (const name of opts.tags ?? []) {
    const [t] = await db.insert(tag).values({ name }).returning({ id: tag.id })
    await db.insert(packageTag).values({ packageId: pkg.id, tagId: t.id })
  }
  return pkg.id
}

/** A resource, marked due unless `due: false` */
async function seedResource(
  packageId: string,
  opts: {
    name?: string | null
    due?: boolean
    state?: string
    embeddingModel?: string | null
    embeddingHash?: string | null
    summary?: string
    hidden?: boolean
  } = {}
) {
  const [row] = await db
    .insert(resource)
    .values({
      packageId,
      name: opts.name === undefined ? 'a.csv' : opts.name,
      state: opts.state ?? 'active',
      summary: opts.summary,
      summaryMeta: opts.hidden ? { hidden: true } : {},
      embedding: opts.embeddingModel ? [9, 9, 9] : undefined,
      embeddingModel: opts.embeddingModel,
      embeddingHash: opts.embeddingHash,
      embeddingDueAt: opts.due === false ? null : sql`NOW() - interval '1 minute'`,
    })
    .returning({ id: resource.id })
  return row.id
}

/** A model that refuses, as too long, any call holding the text of `poison.csv` */
const poisoned = () =>
  makeAi(
    vi.fn(async (texts: string[]) => {
      if (texts.some((t) => t.includes('poison'))) {
        throw new AiInputRejectedError('Too many input tokens', 'too-long')
      }
      return texts.map(() => [1, 2, 3])
    })
  )

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex')

async function state(id: string) {
  const [row] = await db
    .select({
      embedding: resource.embedding,
      embeddingModel: resource.embeddingModel,
      embeddingHash: resource.embeddingHash,
      due: sql<string | null>`${resource.embeddingDueAt}::text`,
    })
    .from(resource)
    .where(eq(resource.id, id))
  return row
}

beforeEach(async () => {
  await cleanDatabase()
})
afterAll(async () => {
  await closeTestDb()
})

describe('embedDueResources', () => {
  it('builds the marked resources of several packages in one provider call', async () => {
    const a = await seedPackage({ title: 'A', tags: ['z', 'y'] })
    const b = await seedPackage({ title: 'B' })
    const r1 = await seedResource(a, { name: 'a.csv' })
    const r2 = await seedResource(b, { name: 'b.csv' })
    const untouched = await seedResource(b, { name: 'c.csv', due: false })
    const { ai, embedBatch } = makeAi()

    const result = await embedDueResources(db, ai)

    expect(result).toMatchObject({ embedded: 2, settled: 0, more: false, busy: false })
    expect(embedBatch).toHaveBeenCalledOnce()
    // Tags in name order: they join the hashed text, so an unstable order
    // would rebuild unchanged resources on every regenerate
    expect([...embedBatch.mock.calls[0][0]].sort()).toEqual(['A\ny z\na.csv', 'B\nb.csv'])
    for (const [id, text] of [
      [r1, 'A\ny z\na.csv'],
      [r2, 'B\nb.csv'],
    ]) {
      expect(await state(id)).toEqual({
        embedding: [1, 2, 3],
        embeddingModel: KEY,
        embeddingHash: hashOf(text),
        due: null,
      })
    }
    expect((await state(untouched)).embeddingModel).toBeNull()
  })

  it('clears the mark without a call when the text and model are unchanged', async () => {
    const pkg = await seedPackage()
    const id = await seedResource(pkg, {
      embeddingModel: KEY,
      embeddingHash: hashOf('タイトル\na.csv'),
    })
    const { ai, embedBatch } = makeAi()

    expect(await embedDueResources(db, ai)).toMatchObject({ embedded: 0, settled: 1, more: false })
    expect(embedBatch).not.toHaveBeenCalled()
    expect(await state(id)).toMatchObject({ embedding: [9, 9, 9], due: null })
  })

  it('rebuilds a vector of another model, the text unchanged', async () => {
    const pkg = await seedPackage()
    // A key without the dimension, as written before it was added
    const id = await seedResource(pkg, {
      embeddingModel: 'test-model',
      embeddingHash: hashOf('タイトル\na.csv'),
    })
    const { ai, embedBatch } = makeAi()

    expect((await embedDueResources(db, ai)).embedded).toBe(1)
    expect(embedBatch).toHaveBeenCalledOnce()
    expect(await state(id)).toMatchObject({ embeddingModel: KEY, due: null })
  })

  it('leaves out an abstract an editor hid', async () => {
    const pkg = await seedPackage()
    await seedResource(pkg, { summary: '見せない抄録。', hidden: true })
    const { ai, embedBatch } = makeAi()

    await embedDueResources(db, ai)

    expect(embedBatch.mock.calls[0][0]).toEqual(['タイトル\na.csv'])
  })

  it('clears the vector of a resource left with nothing to embed', async () => {
    const pkg = await seedPackage({ title: null })
    const id = await seedResource(pkg, { name: null, embeddingModel: KEY, embeddingHash: 'x' })
    const { ai, embedBatch } = makeAi()

    expect(await embedDueResources(db, ai)).toMatchObject({ embedded: 0, settled: 1, more: false })
    expect(embedBatch).not.toHaveBeenCalled()
    expect(await state(id)).toEqual({
      embedding: null,
      embeddingModel: null,
      embeddingHash: null,
      due: null,
    })
  })

  it.each([
    ['of a draft (built at publish, ADR-039)', { state: 'draft' }, {}],
    ['deleted', {}, { state: 'deleted' }],
  ])('only clears the mark of a resource %s', async (_, pkgOpts, resOpts) => {
    const pkg = await seedPackage(pkgOpts)
    const id = await seedResource(pkg, { ...resOpts, embeddingModel: KEY, embeddingHash: 'x' })
    const { ai, embedBatch } = makeAi()

    expect((await embedDueResources(db, ai)).settled).toBe(1)
    expect(embedBatch).not.toHaveBeenCalled()
    expect(await state(id)).toMatchObject({ embedding: [9, 9, 9], due: null })
  })

  it('drops a vector whose text changed while it was built, leaving the newer mark', async () => {
    const pkg = await seedPackage()
    const id = await seedResource(pkg)
    // An edit that lands while the provider is working
    const { ai } = makeAi(
      vi.fn(async (texts: string[]) => {
        await db
          .update(resource)
          .set({ name: 'b.csv', embeddingDueAt: sql`NOW()` })
          .where(eq(resource.id, id))
        return texts.map(() => [1, 2, 3])
      })
    )

    expect((await embedDueResources(db, ai)).embedded).toBe(0)
    const after = await state(id)
    expect(after.embeddingModel).toBeNull()
    expect(after.due).not.toBeNull()

    // The next run builds what the row says now
    const next = makeAi()
    expect((await embedDueResources(db, next.ai)).embedded).toBe(1)
    expect(next.embedBatch.mock.calls[0][0]).toEqual(['タイトル\nb.csv'])
    expect(await state(id)).toMatchObject({ embeddingHash: hashOf('タイトル\nb.csv'), due: null })
  })

  it('records a text the model refuses as too long, and builds the rest', async () => {
    const pkg = await seedPackage()
    const fine = await seedResource(pkg, { name: 'fine.csv' })
    const poison = await seedResource(pkg, {
      name: 'poison.csv',
      embeddingModel: KEY,
      embeddingHash: 'old',
    })
    const { ai, embedBatch } = poisoned()

    const result = await embedDueResources(db, ai)

    // The batch, then each text alone to find which
    expect(embedBatch).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ embedded: 1, rejected: [poison], more: false })
    expect(await state(fine)).toMatchObject({ embeddingModel: KEY, due: null })
    // No vector — not the old text's either — but this model's key and this
    // text's hash: the missing count does not ask for it, and a regenerate
    // does not send it again
    expect(await state(poison)).toEqual({
      embedding: null,
      embeddingModel: KEY,
      embeddingHash: hashOf('タイトル\npoison.csv'),
      due: null,
    })

    await db
      .update(resource)
      .set({ embeddingDueAt: sql`NOW()` })
      .where(eq(resource.id, poison))
    embedBatch.mockClear()
    expect(await embedDueResources(db, ai)).toMatchObject({ settled: 1, rejected: [] })
    expect(embedBatch).not.toHaveBeenCalled()
  })

  it('sends a refused resource again once its text changes', async () => {
    const pkg = await seedPackage()
    const id = await seedResource(pkg, { name: 'poison.csv' })
    const { ai } = poisoned()
    await embedDueResources(db, ai)

    await db
      .update(resource)
      .set({ name: 'shorter.csv', embeddingDueAt: sql`NOW()` })
      .where(eq(resource.id, id))

    expect(await embedDueResources(db, ai)).toMatchObject({ embedded: 1, rejected: [] })
    expect(await state(id)).toMatchObject({ embedding: [1, 2, 3], embeddingModel: KEY })
  })

  it('finds a refused text alone in its batch the same way', async () => {
    const pkg = await seedPackage()
    const poison = await seedResource(pkg, { name: 'poison.csv' })
    const { ai } = poisoned()

    expect(await embedDueResources(db, ai)).toMatchObject({ embedded: 0, rejected: [poison] })
    expect((await state(poison)).due).toBeNull()
  })

  it('throws any other failure for the queue to retry, the batch keeping its marks', async () => {
    const pkg = await seedPackage()
    const ids = [await seedResource(pkg), await seedResource(pkg, { name: 'b.csv' })]
    const before = await Promise.all(ids.map(async (id) => (await state(id)).due))
    const { ai, embedBatch } = makeAi(vi.fn().mockRejectedValue(new Error('provider down')))

    await expect(embedDueResources(db, ai)).rejects.toThrow('provider down')

    // Not sent again one by one: only a refusal of the text is looked into
    expect(embedBatch).toHaveBeenCalledOnce()
    expect(await Promise.all(ids.map(async (id) => (await state(id)).due))).toEqual(before)
  })

  it('throws a failure met while looking for the refused text', async () => {
    const pkg = await seedPackage()
    await seedResource(pkg, { name: 'poison.csv' })
    const fine = await seedResource(pkg, { name: 'fine.csv' })
    const { ai } = makeAi(
      vi
        .fn()
        .mockRejectedValueOnce(new AiInputRejectedError('too many input tokens', 'too-long'))
        .mockRejectedValue(new Error('provider down'))
    )

    await expect(embedDueResources(db, ai)).rejects.toThrow('provider down')
    expect((await state(fine)).due).not.toBeNull()
  })

  it('does nothing while another run holds the lock', async () => {
    const pkg = await seedPackage()
    const id = await seedResource(pkg)
    const { ai, embedBatch } = makeAi()
    let release!: () => void
    let held!: () => void
    const isHeld = new Promise<void>((r) => (held = r))
    const holder = db.transaction(async (tx) => {
      await tryLockInTransaction(tx, RESOURCE_EMBED_LOCK, '')
      held()
      await new Promise<void>((r) => (release = r))
    })
    await isHeld

    expect(await embedDueResources(db, ai)).toMatchObject({ busy: true, embedded: 0 })
    expect(embedBatch).not.toHaveBeenCalled()
    expect((await state(id)).due).not.toBeNull()

    release()
    await holder
    expect(await embedDueResources(db, ai)).toMatchObject({ busy: false, embedded: 1 })
  })

  it('builds at most maxBatches batches, and says marks are left', async () => {
    const pkg = await seedPackage()
    for (let i = 0; i < EMBED_BATCH_SIZE + 1; i++) await seedResource(pkg, { name: `${i}.csv` })
    const { ai, embedBatch } = makeAi()

    expect(await embedDueResources(db, ai, { maxBatches: 1 })).toMatchObject({
      embedded: EMBED_BATCH_SIZE,
      more: true,
    })
    expect(embedBatch).toHaveBeenCalledOnce()

    expect(await embedDueResources(db, ai, { maxBatches: 1 })).toMatchObject({
      embedded: 1,
      more: false,
    })
  })

  it('leaves the marks where embedding is unavailable', async () => {
    const pkg = await seedPackage()
    const id = await seedResource(pkg)
    const ai = { getEmbeddingInfo: () => null } as unknown as AIAdapter

    expect(await embedDueResources(db, ai)).toMatchObject({ embedded: 0, settled: 0 })
    expect((await state(id)).due).not.toBeNull()
  })
})
