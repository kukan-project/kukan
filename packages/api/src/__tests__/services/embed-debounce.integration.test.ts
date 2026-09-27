/** The embed window on the package row (ADR-034): one job per package per window. */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { packageTable } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'
import { enqueueEmbeds, EMBED_DEBOUNCE_MS, EMBED_DELAY_S } from '../../services/search-index'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'
import { mockTransaction } from '../test-helpers/test-app'

const db = getTestDb()
const ai = { getEmbeddingInfo: () => ({ model: 'm', dimension: 4 }) } as unknown as AIAdapter

function mockQueue() {
  return {
    enqueueMany: vi
      .fn()
      .mockImplementation(async (_type: string, data: unknown[]) => data.map(() => 'job')),
    transaction: mockTransaction(),
  } as unknown as QueueAdapter
}

async function addPackage(name: string, state = 'active'): Promise<string> {
  const [row] = await db
    .insert(packageTable)
    .values({ name, state })
    .returning({ id: packageTable.id })
  return row.id
}

/** Move every window back past its length, as the next minute would find it. */
async function passWindow() {
  await db.execute(sql`
    UPDATE package
    SET embedding_queued_at = embedding_queued_at - ${`${EMBED_DEBOUNCE_MS + 1000} milliseconds`}::interval
  `)
}

beforeEach(async () => {
  await cleanDatabase()
})

afterAll(async () => {
  await closeTestDb()
})

describe('enqueueEmbeds', () => {
  it('queues a package once per window, delayed past it', async () => {
    const id = await addPackage('a')
    const queue = mockQueue()
    const forId = eq(packageTable.id, id)

    expect(await enqueueEmbeds(db, queue, ai, forId)).toBe(1)
    expect(queue.enqueueMany).toHaveBeenCalledWith('embed-package', [{ packageId: id }], {
      delaySeconds: EMBED_DELAY_S,
      tx: expect.anything(),
    })
    expect(await enqueueEmbeds(db, queue, ai, forId)).toBe(0)

    await passWindow()
    expect(await enqueueEmbeds(db, queue, ai, forId)).toBe(1)
  })

  it('queues every active package whose window is open, and none twice', async () => {
    const a = await addPackage('a')
    const b = await addPackage('b')
    await addPackage('draft', 'draft')
    const queue = mockQueue()
    await enqueueEmbeds(db, queue, ai, eq(packageTable.id, a))

    expect(await enqueueEmbeds(db, queue, ai, sql`true`)).toBe(1)
    expect(queue.enqueueMany).toHaveBeenLastCalledWith(
      'embed-package',
      [{ packageId: b }],
      expect.anything()
    )
    expect(await enqueueEmbeds(db, queue, ai, sql`true`)).toBe(0)
  })

  it('leaves the window open, and says so, when the jobs could not be written', async () => {
    // The claim and the jobs commit together (ADR-058): a bulk import's next
    // change inside the window is then the one that queues, rather than one
    // more that is suppressed — and the bulk job that asked fails, to be retried.
    const id = await addPackage('a')
    const down = {
      enqueueMany: vi.fn().mockRejectedValue(new Error('connection lost')),
      transaction: mockTransaction(),
    } as unknown as QueueAdapter
    const forId = eq(packageTable.id, id)

    await expect(enqueueEmbeds(db, down, ai, forId)).rejects.toThrow('connection lost')

    expect(await enqueueEmbeds(db, mockQueue(), ai, forId)).toBe(1)
  })

  it('queues nothing when embedding is not configured', async () => {
    await addPackage('a')
    const queue = mockQueue()
    const off = { getEmbeddingInfo: () => null } as unknown as AIAdapter

    expect(await enqueueEmbeds(db, queue, off, sql`true`)).toBe(0)
    expect(queue.enqueueMany).not.toHaveBeenCalled()
  })
})
