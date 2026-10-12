/**
 * An editor's decision about an abstract is written onto the row as it was
 * read (ADR-053 §10.2), so a write that raced it is not undone.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { organization, packageTable, resource, type Database } from '@kukan/db'
import { setResourceSummary } from '../../../services/ai/resource-summary-service'
import { getTestDb, cleanDatabase, closeTestDb } from '../../test-helpers/test-db'

const db = getTestDb()

async function seedResource(): Promise<string> {
  const [org] = await db
    .insert(organization)
    .values({ name: `org-${crypto.randomUUID()}` })
    .returning({ id: organization.id })
  const [pkg] = await db
    .insert(packageTable)
    .values({ name: `pkg-${crypto.randomUUID()}`, state: 'active', ownerOrg: org.id })
    .returning({ id: packageTable.id })
  const [row] = await db
    .insert(resource)
    .values({
      packageId: pkg.id,
      name: 'a.csv',
      state: 'active',
      summary: 'Describes v1.',
      summaryMeta: { source: 'ai', version: 1, hidden: true },
    })
    .returning({ id: resource.id })
  return row.id
}

/**
 * The database, with its first read answering `stale` — the row as it was
 * before a write that landed between the service's read and its own.
 */
function readingStale(stale: unknown): Database {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve([stale]),
  }
  let read = false
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'select' && !read) {
        read = true
        return () => chain
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

beforeEach(async () => {
  await cleanDatabase()
})
afterAll(async () => {
  await closeTestDb()
})

describe('setResourceSummary', () => {
  it('does not write back text a purge took off after it was read', async () => {
    const id = await seedResource()
    const [before] = await db
      .select({
        packageId: resource.packageId,
        summary: resource.summary,
        meta: resource.summaryMeta,
      })
      .from(resource)
      .where(eq(resource.id, id))
    // The purge lands after the read.
    await db
      .update(resource)
      .set({ summary: null, summaryMeta: { hidden: true } })
      .where(eq(resource.id, id))

    await expect(setResourceSummary(readingStale(before), id, { hidden: false })).rejects.toThrow(
      /changed while being edited/
    )

    const [row] = await db
      .select({ summary: resource.summary, meta: resource.summaryMeta })
      .from(resource)
      .where(eq(resource.id, id))
    expect(row).toEqual({ summary: null, meta: { hidden: true } })
  })

  it('writes when nothing moved in between', async () => {
    const id = await seedResource()

    await setResourceSummary(db, id, { hidden: false })

    const [row] = await db
      .select({ summary: resource.summary, meta: resource.summaryMeta })
      .from(resource)
      .where(eq(resource.id, id))
    expect(row).toEqual({ summary: 'Describes v1.', meta: { source: 'ai', version: 1 } })
  })
})
