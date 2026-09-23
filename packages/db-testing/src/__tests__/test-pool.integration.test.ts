/**
 * What the truncate promises the test after it, against a real pool.
 *
 * Every case is about a query the harness did not start and cannot await: one
 * already running when the truncate comes, one starting while it runs, one that
 * writes after it, and one that never stops. See {@link ../test-pool.ts} for
 * where each of those comes from.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, inject } from 'vitest'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  createEmptyDatabase,
  createTestPool,
  testDatabaseName,
  testDatabaseUrl,
  truncateTables,
} from '../index'
import { budget, runExclusively } from '../test-pool'

/** What `createTestPool` gives every harness; the error message names it. */
const POOL_MAX = 2

/** One table of this file's own says everything the api's eighteen would. */
const TABLES = ['leftover']

let pool: ReturnType<typeof createTestPool>

beforeAll(async () => {
  // Empty rather than a copy of the template: these tests bring their own table.
  const name = testDatabaseName(inject('testDbPrefix'))
  await createEmptyDatabase(name)
  pool = createTestPool(testDatabaseUrl(name))
  for (const table of TABLES) await pool.query(`CREATE TABLE ${table} (id int)`)
})

beforeEach(async () => {
  await pool.query('TRUNCATE TABLE leftover')
})

afterAll(async () => {
  await pool.end()
})

const rows = async () =>
  Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM leftover')).rows[0].n)

describe('truncateTables', () => {
  it('waits for a query that is still running', async () => {
    const order: string[] = []
    // pg_sleep takes no table lock, so nothing but the wait puts these in
    // order — a leftover read of several tables is what deadlocks instead.
    const inflight = pool.query('SELECT pg_sleep(0.2)').then(() => order.push('inflight'))
    const truncate = truncateTables(pool, TABLES).then(() => order.push('truncate'))

    await Promise.all([inflight, truncate])
    expect(order).toEqual(['inflight', 'truncate'])
  })

  it('leaves the tables empty when a leftover would write to them afterwards', async () => {
    // The shape that holding the pool alone does not cover: the read finishes
    // before the truncate and the insert is queued behind it, so the insert
    // lands on a table the truncate has just emptied.
    const leftover = (async () => {
      await pool.query('SELECT pg_sleep(0.05)')
      await pool.query('INSERT INTO leftover (id) VALUES (1)')
    })()

    await truncateTables(pool, TABLES)

    // Awaited before counting because a count issued straight after the
    // truncate is served before the insert lands — measured — and would read 0
    // whether the insert was dealt with or merely still in flight.
    await leftover
    expect(await rows()).toBe(0)
  })

  it('gives up rather than truncating forever against work that never stops', async () => {
    let querying = true
    const loop = (async () => {
      while (querying) await pool.query('SELECT 1')
    })()

    await expect(truncateTables(pool, TABLES)).rejects.toThrow(/queued every time/)

    querying = false
    await loop
  })
})

describe('runExclusively', () => {
  it('keeps every connection until it is done, so a query starting late waits', async () => {
    const order: string[] = []
    const exclusive = runExclusively(pool, 'SELECT pg_sleep(0.2)').then(() => order.push('held'))
    // Long enough to be after the statement above started, short enough to be
    // well inside it.
    await sleep(20)
    const late = pool.query('SELECT 1').then(() => order.push('late'))

    await Promise.all([exclusive, late])
    expect(order).toEqual(['held', 'late'])
  })

  it('says what it waited for, and gives back what it got, when a client is never released', async () => {
    const leaked = await pool.connect()
    await expect(runExclusively(pool, 'SELECT 1', budget(50))).rejects.toThrow(
      new RegExp(`Waited 50ms for the test pool's ${POOL_MAX} connections and got ${POOL_MAX - 1}`)
    )
    leaked.release()

    // Both are free again: the one that gave up holding nothing, and the one its
    // pending request collected after it had. Without that, every later call in
    // the file waits for connections this one is sitting on.
    await expect(runExclusively(pool, 'SELECT 1', budget(1_000))).resolves.toBe(true)
  })

  it('spends one wait across the attempts that share it, not one each', async () => {
    const leaked = await pool.connect()
    const waiting = budget(200)

    const started = Date.now()
    await expect(runExclusively(pool, 'SELECT 1', waiting)).rejects.toThrow()
    await expect(runExclusively(pool, 'SELECT 1', waiting)).rejects.toThrow()
    leaked.release()

    // The second attempt had nothing left to wait with. A wait each would be
    // 400ms here and five of them would outlast the 10s hook timeout that this
    // budget exists to report ahead of.
    expect(Date.now() - started).toBeLessThan(350)
  })
})
