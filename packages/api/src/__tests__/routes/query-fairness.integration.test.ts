/**
 * Each caller's share of the DuckDB slot (ADR-032 Part B): how the query route
 * and the MCP tool key a caller, refuse its next request once its share is in
 * flight, and serve a signed-in caller ahead of anonymous ones.
 *
 * The query itself is stubbed: what runs in the slot is held open until the
 * test lets it go, so "while the first is still running" is a fact the test
 * controls rather than a race against DuckDB. The route, the service and the
 * slot are real.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { createTestApp, mockStorage } from '../test-helpers/test-app'
import { createQueryableResource as createQueryable } from '../test-helpers/queryable-resource'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'

/** The queries the stub is holding, in the order they reached the slot. */
const held: Array<{ marker: string; release: () => void }> = []
/** Every query the stub ran, by marker, in the order it ran them. */
const ran: string[] = []

vi.mock('../../services/query/query-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/query/query-process')>()
  return {
    ...actual,
    runQueryInProcess: vi.fn(async (_location: string, sql: string) => {
      const marker = /'([a-z0-9-]+)'/.exec(sql)?.[1] ?? sql
      ran.push(marker)
      if (marker.startsWith('hold')) {
        await new Promise<void>((resolve) => {
          const entry = {
            marker,
            release: () => {
              held.splice(held.indexOf(entry), 1)
              resolve()
            },
          }
          held.push(entry)
        })
      }
      return { columns: ['marker'], rows: [{ marker }], rowCount: 1, truncated: false }
    }),
  }
})

const db = getTestDb()
const storage = { ...mockStorage, getSignedUrl: async () => 'file:///stubbed.parquet' }
/** The default sysadmin, for setting up and for the signed-in cases. */
const app = createTestApp(db, { storage })
const anonymous = createTestApp(db, { storage, user: null })

const IP_A = '203.0.113.5'
const IP_B = '203.0.113.6'

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
  ran.length = 0
})

afterEach(() => {
  // A query left held would wedge every later case: the slot is one per process
  for (const h of [...held]) h.release()
})

afterAll(async () => {
  await closeTestDb()
})

const createQueryableResource = () => createQueryable(app, db)

async function query(target: typeof app, id: string, marker: string, ip?: string) {
  return target.request(`/api/v1/resources/${id}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ip === undefined ? {} : { 'x-forwarded-for': ip }),
    },
    body: JSON.stringify({ sql: `SELECT '${marker}' AS marker FROM data` }),
  })
}

async function mcpQuery(target: typeof app, id: string, marker: string, ip?: string) {
  return target.request('/api/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(ip === undefined ? {} : { 'x-forwarded-for': ip }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'query_resource', arguments: { id, sql: `SELECT '${marker}' AS marker` } },
    }),
  })
}

/** Wait until the stub holds `count` queries — i.e. they reached the slot. */
async function untilHeld(count: number): Promise<void> {
  for (let i = 0; i < 200 && held.length < count; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  expect(held.length).toBe(count)
}

/** Whether `p` has settled within a short while — for asserting a request is still waiting. */
async function settledSoon(p: Promise<unknown>): Promise<boolean> {
  const pending = Symbol('pending')
  const outcome = await Promise.race([
    p.then(
      () => 'settled',
      () => 'settled'
    ),
    new Promise((r) => setTimeout(() => r(pending), 300)),
  ])
  return outcome !== pending
}

const CALLER_BUSY = 'Another query from this caller is still running'

/** The anonymous share of the slot and its queue (config §QUERY_CALLER_MAX_ANONYMOUS). */
const ANONYMOUS_SHARE = 4

/**
 * Fill an address's share through `send`: one request held in the slot and the
 * rest queued behind it. Returns all of them, to be awaited once the held one
 * is released, by which time the rest have run in turn.
 */
async function fillShare(
  send: (marker: string) => Promise<Response>,
  marker: string
): Promise<Promise<Response>[]> {
  const first = send(`hold-${marker}`)
  await untilHeld(1)
  const queued = Array.from({ length: ANONYMOUS_SHARE - 1 }, (_, i) =>
    send(`fast-${marker}-${i + 2}`)
  )
  // Each does its own database work before it is counted; give them time to be
  await new Promise((r) => setTimeout(r, 300))
  return [first, ...queued]
}

describe('per-caller share of the query slot', () => {
  it('refuses the fifth anonymous query from one address while four are in flight', async () => {
    const id = await createQueryableResource()
    const inFlight = await fillShare((marker) => query(anonymous, id, marker, IP_A), 'a')

    const fifth = await query(anonymous, id, 'fast-a-5', IP_A)
    expect(fifth.status).toBe(429)
    expect(fifth.headers.get('Retry-After')).toBe('1')
    const problem = await fifth.json()
    expect(problem.title).toBe('TOO_MANY_REQUESTS')
    expect(problem.detail).toContain(CALLER_BUSY)
    // Refused before the slot, not after a wait in its queue
    expect(ran).toEqual(['hold-a'])

    held[0].release()
    for (const res of await Promise.all(inFlight)) expect(res.status).toBe(200)
    // The queued ones ran once the slot freed — in whichever order they reached it
    expect(ran.slice(1).sort()).toEqual(['fast-a-2', 'fast-a-3', 'fast-a-4'])

    // And the share is given back once they are done
    const next = await query(anonymous, id, 'fast-a-6', IP_A)
    expect(next.status).toBe(200)
  })

  it('admits another address, and serves a signed-in caller ahead of it', async () => {
    const id = await createQueryableResource()
    const first = query(anonymous, id, 'hold-a', IP_A)
    await untilHeld(1)

    // Both reach the queue: another anonymous address is not the first's caller,
    // and a signed-in caller is keyed by user even from the first's own address
    const other = query(anonymous, id, 'fast-b', IP_B)
    await new Promise((r) => setTimeout(r, 300))
    const signedIn = query(app, id, 'fast-user', IP_A)
    expect(await settledSoon(Promise.all([other, signedIn]))).toBe(false)

    held[0].release()
    expect((await first).status).toBe(200)
    expect((await signedIn).status).toBe(200)
    expect((await other).status).toBe(200)
    // The slot went to the signed-in caller first, though it queued last
    expect(ran).toEqual(['hold-a', 'fast-user', 'fast-b'])
  })

  it('folds an IPv6 address to its /64, so the next address over is the same caller', async () => {
    const id = await createQueryableResource()
    const inFlight = await fillShare(
      (marker) => query(anonymous, id, marker, '2001:db8:1:2::10'),
      'v6'
    )

    const neighbour = await query(anonymous, id, 'fast-v6-near', '2001:db8:1:2:ffff::1')
    expect(neighbour.status).toBe(429)
    expect((await neighbour.json()).detail).toContain(CALLER_BUSY)

    const elsewhere = query(anonymous, id, 'fast-v6-far', '2001:db8:1:3::10')
    expect(await settledSoon(elsewhere)).toBe(false)
    held[0].release()
    for (const res of await Promise.all(inFlight)) expect(res.status).toBe(200)
    expect((await elsewhere).status).toBe(200)
  })

  it('does not cap anonymous requests whose address is unknown', async () => {
    // No header at all — a direct connection. Sharing one bucket between every
    // such request would have them refuse each other, so they queue instead.
    const id = await createQueryableResource()
    const first = query(anonymous, id, 'hold-noip')
    await untilHeld(1)

    const more = Array.from({ length: ANONYMOUS_SHARE }, (_, i) =>
      query(anonymous, id, `fast-noip-${i}`)
    )
    expect(await settledSoon(Promise.all(more))).toBe(false)

    held[0].release()
    expect((await first).status).toBe(200)
    for (const res of await Promise.all(more)) expect(res.status).toBe(200)
  })

  it('counts two in flight for a signed-in caller', async () => {
    const id = await createQueryableResource()
    const first = query(app, id, 'hold-u1', IP_A)
    await untilHeld(1)
    const second = query(app, id, 'fast-u2', IP_A)
    expect(await settledSoon(second)).toBe(false)

    const third = await query(app, id, 'fast-u3', IP_A)
    expect(third.status).toBe(429)
    expect((await third.json()).detail).toContain(CALLER_BUSY)

    held[0].release()
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
  })

  it('counts the MCP tool against the same caller as the REST route', async () => {
    const id = await createQueryableResource()
    const inFlight = await fillShare((marker) => query(anonymous, id, marker, IP_A), 'a')

    const res = await mcpQuery(anonymous, id, 'fast-mcp', IP_A)
    const body = await res.json()
    expect(body.result.isError).toBe(true)
    expect(JSON.stringify(body.result.content)).toContain(CALLER_BUSY)
    expect(ran).toEqual(['hold-a'])

    held[0].release()
    await Promise.all(inFlight)

    // The other way round too: tool calls hold the share a REST query is refused on
    const tools = await fillShare((marker) => mcpQuery(anonymous, id, marker, IP_B), 'mcp')
    const rest = await query(anonymous, id, 'fast-b', IP_B)
    expect(rest.status).toBe(429)
    held[0].release()
    for (const toolRes of await Promise.all(tools)) {
      expect(((await toolRes.json()) as { result: { isError?: boolean } }).result.isError).toBe(
        undefined
      )
    }
  })
})
