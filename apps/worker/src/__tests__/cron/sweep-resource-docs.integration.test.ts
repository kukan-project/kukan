/**
 * The sweep that answers a sync the queue never heard about (ADR-053 §9.3).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { packageTable, resource } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import { createLogger, SYNC_RESOURCE_DOC_JOB_TYPE } from '@kukan/shared'
import { sweepResourceDocs } from '../../cron/sweep-resource-docs'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const log = createLogger({ name: 'test', level: 'silent' })

function fakeQueue() {
  const enqueue = vi.fn().mockResolvedValue('job')
  return { queue: { enqueue } as unknown as QueueAdapter, enqueue }
}

/** A published resource, marked due and old enough to be swept */
async function seed(opts: { synced?: boolean; packageState?: string } = {}) {
  const [org] = await db
    .insert(packageTable)
    .values({ name: `pkg-${crypto.randomUUID()}`, state: opts.packageState ?? 'active' })
    .returning({ id: packageTable.id })
  const [row] = await db
    .insert(resource)
    .values({
      packageId: org.id,
      name: 'r.csv',
      state: 'active',
      // Null means the document agrees; a value is when they stopped agreeing,
      // here older than the sweep's grace period
      docSyncDueAt: opts.synced ? null : sql`NOW() - interval '1 hour'`,
    })
    .returning({ id: resource.id })
  return row.id
}

beforeEach(async () => {
  await cleanDatabase()
})
afterAll(async () => {
  await closeTestDb()
})

describe('sweepResourceDocs', () => {
  it('asks for one sync however many documents nobody heard about', async () => {
    // The sync works through every mark, so one waiting job covers them all
    await seed()
    await seed()
    const { queue, enqueue } = fakeQueue()

    expect(await sweepResourceDocs(db, queue, log)).toBe(true)
    expect(enqueue).toHaveBeenCalledOnce()
    expect(enqueue).toHaveBeenCalledWith(SYNC_RESOURCE_DOC_JOB_TYPE, {}, { unlessWaiting: true })
  })

  it('leaves a document that already agrees with its row', async () => {
    await seed({ synced: true })
    const { queue, enqueue } = fakeQueue()

    expect(await sweepResourceDocs(db, queue, log)).toBe(false)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it("asks for a draft's mark too, which the sync clears without a write", async () => {
    // Left alone, the marks of drafts never published would pile up
    await seed({ packageState: 'draft' })
    const { queue, enqueue } = fakeQueue()

    expect(await sweepResourceDocs(db, queue, log)).toBe(true)
    expect(enqueue).toHaveBeenCalledOnce()
  })

  it('leaves a row marked seconds ago to the job it was marked for', async () => {
    const [pkg] = await db
      .insert(packageTable)
      .values({ name: 'pkg-fresh', state: 'active' })
      .returning({ id: packageTable.id })
    await db
      .insert(resource)
      .values({ packageId: pkg.id, name: 'fresh.csv', state: 'active', docSyncDueAt: sql`NOW()` })
    const { queue, enqueue } = fakeQueue()

    expect(await sweepResourceDocs(db, queue, log)).toBe(false)
    expect(enqueue).not.toHaveBeenCalled()
  })
})
