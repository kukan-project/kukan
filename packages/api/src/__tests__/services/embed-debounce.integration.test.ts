/** The embed window on the package row (ADR-034): one job per package per window. */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { packageTable } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'
import type { Logger } from '@kukan/shared'
import { enqueueEmbeds, EMBED_DEBOUNCE_MS, EMBED_DELAY_S } from '../../services/search-index'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const ai = { getEmbeddingInfo: () => ({ model: 'm', dimension: 4 }) } as unknown as AIAdapter
const logger = { error: vi.fn() } as unknown as Logger

function mockQueue() {
  return { enqueue: vi.fn().mockResolvedValue('job') } as unknown as QueueAdapter
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

    expect(await enqueueEmbeds(db, queue, ai, forId, logger)).toEqual({ enqueued: 1, failed: 0 })
    expect(queue.enqueue).toHaveBeenCalledWith(
      'embed-package',
      { packageId: id },
      { delaySeconds: EMBED_DELAY_S }
    )
    expect(await enqueueEmbeds(db, queue, ai, forId, logger)).toEqual({ enqueued: 0, failed: 0 })

    await passWindow()
    expect(await enqueueEmbeds(db, queue, ai, forId, logger)).toEqual({ enqueued: 1, failed: 0 })
  })

  it('queues every active package whose window is open, and none twice', async () => {
    const a = await addPackage('a')
    const b = await addPackage('b')
    await addPackage('draft', 'draft')
    const queue = mockQueue()
    await enqueueEmbeds(db, queue, ai, eq(packageTable.id, a), logger)

    expect(await enqueueEmbeds(db, queue, ai, sql`true`, logger)).toEqual({
      enqueued: 1,
      failed: 0,
    })
    expect(queue.enqueue).toHaveBeenLastCalledWith(
      'embed-package',
      { packageId: b },
      expect.anything()
    )
    expect(await enqueueEmbeds(db, queue, ai, sql`true`, logger)).toEqual({
      enqueued: 0,
      failed: 0,
    })
  })

  it('gives the window back when the job could not be queued', async () => {
    // A bulk import's next change inside the window is then the one that
    // queues, rather than one more that is suppressed.
    const id = await addPackage('a')
    const down = {
      enqueue: vi.fn().mockRejectedValue(new Error('queue down')),
    } as unknown as QueueAdapter
    const forId = eq(packageTable.id, id)

    expect(await enqueueEmbeds(db, down, ai, forId, logger)).toEqual({ enqueued: 0, failed: 1 })

    const queue = mockQueue()
    expect(await enqueueEmbeds(db, queue, ai, forId, logger)).toEqual({ enqueued: 1, failed: 0 })
  })

  it('does not give back a window another caller has claimed since', async () => {
    // The stamp is the guard: released blindly, the other caller's job would
    // be followed by a duplicate from the next change.
    const id = await addPackage('a')
    const forId = eq(packageTable.id, id)
    const queue = mockQueue()
    const down = {
      enqueue: vi.fn().mockRejectedValue(new Error('queue down')),
    } as unknown as QueueAdapter

    await enqueueEmbeds(db, down, ai, forId, logger)
    // The failed claim's stamp expires, and a fresh claim lands on the row...
    await passWindow()
    await enqueueEmbeds(db, queue, ai, forId, logger)
    // ...so a release aimed at the old stamp must not clear it.
    await db.execute(sql`
      UPDATE package SET embedding_queued_at = NULL
      WHERE id = ${id} AND embedding_queued_at = now() - ${`${EMBED_DEBOUNCE_MS + 1000} milliseconds`}::interval
    `)
    expect(await enqueueEmbeds(db, queue, ai, forId, logger)).toEqual({ enqueued: 0, failed: 0 })
  })

  it('queues nothing when embedding is not configured', async () => {
    await addPackage('a')
    const queue = mockQueue()
    const off = { getEmbeddingInfo: () => null } as unknown as AIAdapter

    expect(await enqueueEmbeds(db, queue, off, sql`true`, logger)).toEqual({
      enqueued: 0,
      failed: 0,
    })
    expect(queue.enqueue).not.toHaveBeenCalled()
  })
})
