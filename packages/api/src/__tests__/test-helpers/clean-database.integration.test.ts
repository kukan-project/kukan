/**
 * That `cleanDatabase` truncates through the pool, not around it.
 *
 * The mechanism and the deadlock it avoids belong to `@kukan/db-testing`, which
 * tests them; what this pins is the wiring every other integration file in this
 * package depends on for its isolation.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { cleanDatabase, closeTestDb, getTestDb } from './test-db'

afterAll(async () => {
  await closeTestDb()
})

describe('cleanDatabase', () => {
  it('truncates only once a query the previous test left running has finished', async () => {
    const order: string[] = []
    // pg_sleep takes no table lock, so the truncate would go first on nothing
    // but a free connection — which is what it used to find.
    const inflight = getTestDb()
      .execute(sql`SELECT pg_sleep(0.2)`)
      .then(() => order.push('query'))
    const cleaned = cleanDatabase().then(() => order.push('truncate'))

    await Promise.all([inflight, cleaned])
    expect(order).toEqual(['query', 'truncate'])
  })
})
