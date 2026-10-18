import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { rateLimit } from '@kukan/db'
import { EDGE_CLIENT_IP_HEADER } from '@kukan/shared'
import { getTestDb, cleanDatabase, cleanUsers, closeTestDb } from '../test-helpers/test-db'
import { createAuth } from '../../auth/auth'
import { pruneRateLimits } from '../../services/auth-rate-limit'
import { resetBootstrapCache } from '../../services/bootstrap'

const db = getTestDb()
const HOUR_MS = 60 * 60 * 1000

beforeEach(async () => {
  await cleanDatabase()
  await cleanUsers()
  resetBootstrapCache()
})

afterAll(async () => {
  await closeTestDb()
})

function signIn(viewer: string) {
  return new Request('http://localhost:3000/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [EDGE_CLIENT_IP_HEADER]: viewer },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'harbor-lantern-quiet-42' }),
  })
}

async function keys() {
  const rows = await db.select({ key: rateLimit.key }).from(rateLimit)
  return rows.map((r) => r.key).sort()
}

describe('pruneRateLimits', () => {
  it('deletes the counters Better Auth leaves behind for addresses that do not return', async () => {
    const auth = createAuth(db, EDGE_CLIENT_IP_HEADER)
    await auth.handler(signIn('198.51.100.7'))
    // Its window long over, as for a scanner that moved on
    await db.update(rateLimit).set({ lastRequest: sql`${rateLimit.lastRequest} - ${2 * HOUR_MS}` })
    await auth.handler(signIn('203.0.113.9'))

    // Better Auth prunes only when an existing key's window restarts
    expect(await keys()).toEqual(['198.51.100.7|/sign-in/email', '203.0.113.9|/sign-in/email'])

    expect(await pruneRateLimits(db, HOUR_MS)).toBe(1)
    expect(await keys()).toEqual(['203.0.113.9|/sign-in/email'])
  })
})
