import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { rateLimit, session, verification } from '@kukan/db'
import { EDGE_CLIENT_IP_HEADER } from '@kukan/shared'
import {
  getTestDb,
  cleanDatabase,
  cleanUsers,
  closeTestDb,
  ensureTestUser,
  TEST_USER_ID,
} from '../test-helpers/test-db'
import { createAuth } from '../../auth/auth'
import { pruneExpiredAuthRows } from '../../services/auth-cleanup'
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

describe('pruneExpiredAuthRows', () => {
  it('deletes the counters Better Auth leaves behind for addresses that do not return', async () => {
    const auth = createAuth(db, EDGE_CLIENT_IP_HEADER)
    await auth.handler(signIn('198.51.100.7'))
    // Its window long over, as for a scanner that moved on
    await db.update(rateLimit).set({ lastRequest: sql`${rateLimit.lastRequest} - ${2 * HOUR_MS}` })
    await auth.handler(signIn('203.0.113.9'))

    // Better Auth prunes only when an existing key's window restarts
    expect(await keys()).toEqual(['198.51.100.7|/sign-in/email', '203.0.113.9|/sign-in/email'])

    expect((await pruneExpiredAuthRows(db, HOUR_MS)).rateLimits).toBe(1)
    expect(await keys()).toEqual(['203.0.113.9|/sign-in/email'])
  })

  it('deletes expired sessions and verifications, and keeps the live ones', async () => {
    await ensureTestUser()
    const past = new Date(Date.now() - 60_000)
    const future = new Date(Date.now() + HOUR_MS)
    await db.insert(session).values([
      { id: 'expired', userId: TEST_USER_ID, token: 'expired-token', expiresAt: past },
      { id: 'live', userId: TEST_USER_ID, token: 'live-token', expiresAt: future },
    ])
    await db.insert(verification).values([
      { identifier: 'expired', value: 'x', expiresAt: past },
      { identifier: 'live', value: 'x', expiresAt: future },
    ])

    expect(await pruneExpiredAuthRows(db, HOUR_MS)).toEqual({
      sessions: 1,
      verifications: 1,
      rateLimits: 0,
    })
    expect(await db.select({ id: session.id }).from(session)).toEqual([{ id: 'live' }])
    expect(await db.select({ identifier: verification.identifier }).from(verification)).toEqual([
      { identifier: 'live' },
    ])
  })
})
