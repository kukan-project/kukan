/**
 * Integration tests for the per-host fetch limit and the turns runs wait in.
 *
 * Both are one statement each against `fetch_rate_limit`, and what they promise
 * — never two fetches within the interval, and a line of waiting runs that each
 * come back once — is decided by that SQL, so it is tested against a database.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, afterAll } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { fetchRateLimit } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { buildPipelineContext } from '../../../pipeline/run/build-context'
import { FETCH_RATE_LIMIT_INTERVAL_S, FETCH_TURN_SPACING_S } from '../../../config'
import { getTestDb, closeTestDb } from '../../test-helpers/test-db'

const db = getTestDb()
const ctx = buildPipelineContext(db, {} as StorageAdapter, undefined)

/** A host of the case's own, so cases never share a row. */
const host = () => `${randomUUID()}.example.com`

async function setRow(fqdn: string, lastAgoS: number, reservedInS: number | null) {
  await db.insert(fetchRateLimit).values({
    fqdn,
    lastFetchedAt: sql`now() - ${`${lastAgoS} seconds`}::interval`,
    reservedUntil: reservedInS === null ? null : sql`now() + ${`${reservedInS} seconds`}::interval`,
  })
}

async function lastFetchedAgoS(fqdn: string): Promise<number> {
  const [row] = await db
    .select({ ago: sql<string>`extract(epoch from now() - ${fetchRateLimit.lastFetchedAt})` })
    .from(fetchRateLimit)
    .where(eq(fetchRateLimit.fqdn, fqdn))
  return Number(row.ago)
}

afterAll(async () => {
  await closeTestDb()
})

describe('reserveFetchTurn', () => {
  it('takes the slot of a host nobody has fetched', async () => {
    const fqdn = host()
    expect(await ctx.reserveFetchTurn(fqdn)).toBe(0)
    expect(await lastFetchedAgoS(fqdn)).toBeLessThan(1)
  })

  it('hands the runs that cannot fetch turns one spacing apart, in order', async () => {
    const fqdn = host()
    expect(await ctx.reserveFetchTurn(fqdn)).toBe(0)
    const turns = [
      await ctx.reserveFetchTurn(fqdn),
      await ctx.reserveFetchTurn(fqdn),
      await ctx.reserveFetchTurn(fqdn),
    ]
    turns.forEach((t, i) => expect(t).toBeCloseTo(FETCH_TURN_SPACING_S * (i + 1), 0))
    // A turn handed out is not a fetch: the interval still runs from the last one
    expect(await lastFetchedAgoS(fqdn)).toBeLessThan(1)
  })

  it('puts a new run behind the turns already handed out, though the interval has passed', async () => {
    const fqdn = host()
    await setRow(fqdn, 60, 30)
    expect(await ctx.reserveFetchTurn(fqdn)).toBeCloseTo(30 + FETCH_TURN_SPACING_S, 0)
    expect(await lastFetchedAgoS(fqdn)).toBeCloseTo(60, 0)
  })

  it('waits out the interval after a fetch that took no turn', async () => {
    // A redirect hop, or a run someone waits for: it took the slot directly
    const fqdn = host()
    await setRow(fqdn, 2, null)
    expect(await ctx.reserveFetchTurn(fqdn)).toBeCloseTo(FETCH_RATE_LIMIT_INTERVAL_S - 2, 0)
  })

  it('takes the slot once every turn handed out has come and gone', async () => {
    const fqdn = host()
    await setRow(fqdn, 60, -60)
    expect(await ctx.reserveFetchTurn(fqdn)).toBe(0)
    expect(await lastFetchedAgoS(fqdn)).toBeLessThan(1)
  })
})

describe('acquireFetchSlot', () => {
  it('lets a run that comes back to its turn fetch, and not the next one before the interval', async () => {
    const fqdn = host()
    expect(await ctx.reserveFetchTurn(fqdn)).toBe(0)
    expect(await ctx.reserveFetchTurn(fqdn)).toBeGreaterThan(0)
    // The turn's run came back a spacing later: the fetch before it is that far behind
    await db
      .update(fetchRateLimit)
      .set({ lastFetchedAt: sql`now() - ${`${FETCH_TURN_SPACING_S} seconds`}::interval` })
      .where(eq(fetchRateLimit.fqdn, fqdn))
    expect(await ctx.acquireFetchSlot(fqdn)).toBe(0)
    expect(await ctx.acquireFetchSlot(fqdn)).toBeCloseTo(FETCH_RATE_LIMIT_INTERVAL_S, 0)
  })

  it('says how long the slot has left when it refuses, and leaves the last fetch alone', async () => {
    const fqdn = host()
    await setRow(fqdn, 2, null)
    expect(await ctx.acquireFetchSlot(fqdn)).toBeCloseTo(FETCH_RATE_LIMIT_INTERVAL_S - 2, 0)
    expect(await lastFetchedAgoS(fqdn)).toBeCloseTo(2, 0)
  })

  it('takes the slot of a host nobody has fetched', async () => {
    expect(await ctx.acquireFetchSlot(host())).toBe(0)
  })

  it('refuses the second of two takes that share a transaction time', async () => {
    // Read off the row's time, the refused take would find its own NOW() there
    const fqdn = host()
    await setRow(fqdn, 60, null)
    const twice = await db.transaction(async (tx) => {
      const inTx = buildPipelineContext(tx as unknown as typeof db, {} as StorageAdapter, undefined)
      return [await inTx.acquireFetchSlot(fqdn), await inTx.acquireFetchSlot(fqdn)]
    })
    expect(twice[0]).toBe(0)
    expect(twice[1]).toBeCloseTo(FETCH_RATE_LIMIT_INTERVAL_S, 0)
  })
})
