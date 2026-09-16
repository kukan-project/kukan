/**
 * Clearing the document's due mark is a compare-and-set (ADR-053 §9.3).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { packageTable, resource } from '@kukan/db'
import type { SearchAdapter } from '@kukan/search-adapter'
import { syncResourceDoc } from '../../services/search-index'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()

async function seedDue() {
  const [pkg] = await db
    .insert(packageTable)
    .values({ name: `pkg-${crypto.randomUUID()}`, state: 'active' })
    .returning({ id: packageTable.id })
  const [row] = await db
    .insert(resource)
    .values({
      packageId: pkg.id,
      name: 'r.csv',
      state: 'active',
      docSyncDueAt: sql`NOW() - interval '1 minute'`,
    })
    .returning({ id: resource.id })
  return row.id
}

const dueAt = async (id: string) =>
  (await db.select({ d: resource.docSyncDueAt }).from(resource).where(eq(resource.id, id)))[0].d

beforeEach(async () => {
  await cleanDatabase()
})
afterAll(async () => {
  await closeTestDb()
})

describe('syncResourceDoc', () => {
  it('clears the mark it started from', async () => {
    const id = await seedDue()
    const search = { indexResource: vi.fn() } as unknown as SearchAdapter

    await syncResourceDoc(db, search, id)

    expect(await dueAt(id)).toBeNull()
  })

  it('leaves an edit that landed while it was writing', async () => {
    // A hide made in that window must not be dropped: the projection takes a
    // hidden abstract off the document, and clearing regardless would leave
    // text somebody took down answering searches.
    const id = await seedDue()
    const search = {
      indexResource: vi.fn().mockImplementation(async () => {
        await db
          .update(resource)
          .set({ docSyncDueAt: sql`NOW()` })
          .where(eq(resource.id, id))
      }),
    } as unknown as SearchAdapter

    await syncResourceDoc(db, search, id)

    // Still due, so the sweep comes back for the edit this run did not carry
    expect(await dueAt(id)).not.toBeNull()
  })
})
