/**
 * The sign-in rate limit counts in the database, so every web process shares
 * it, and counts each client by the address the edge states rather than by
 * `X-Forwarded-For`, which ends in CloudFront's own.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { rateLimit } from '@kukan/db'
import { EDGE_CLIENT_IP_HEADER } from '@kukan/shared'
import { getTestDb, cleanDatabase, cleanUsers, closeTestDb } from '../test-helpers/test-db'
import { createAuth } from '../../auth/auth'
import { resetBootstrapCache } from '../../services/bootstrap'

const db = getTestDb()

beforeEach(async () => {
  await cleanDatabase()
  await cleanUsers()
  resetBootstrapCache()
})

afterAll(async () => {
  await closeTestDb()
})

/** A sign-in as it arrives from CloudFront through the ALB. */
function signIn(viewer: string) {
  return new Request('http://localhost:3000/api/auth/sign-in/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [EDGE_CLIENT_IP_HEADER]: viewer,
      'x-forwarded-for': `${viewer}, 130.176.0.1`,
    },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'harbor-lantern-quiet-42' }),
  })
}

describe('sign-in rate limit', () => {
  it('counts in the database, per client', async () => {
    const auth = createAuth(db, EDGE_CLIENT_IP_HEADER)

    // Better Auth allows three sign-ins per address in ten seconds
    const statuses = []
    for (let i = 0; i < 4; i++) statuses.push((await auth.handler(signIn('198.51.100.7'))).status)

    expect(statuses.slice(0, 3)).not.toContain(429)
    expect(statuses[3]).toBe(429)
    expect((await auth.handler(signIn('203.0.113.9'))).status).not.toBe(429)
    // In the table rather than process memory, where another task would not see it
    const rows = await db.select({ key: rateLimit.key, count: rateLimit.count }).from(rateLimit)
    expect(rows).toEqual(
      expect.arrayContaining([
        { key: '198.51.100.7|/sign-in/email', count: 3 },
        { key: '203.0.113.9|/sign-in/email', count: 1 },
      ])
    )
  })

  it('ignores the edge header where it is not trusted', async () => {
    // Without CloudFront in front, a client could rotate it to escape the limit
    const auth = createAuth(db, 'x-forwarded-for')
    const statuses = []
    for (let i = 0; i < 4; i++) {
      const req = new Request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [EDGE_CLIENT_IP_HEADER]: `203.0.113.${i}`,
          'x-forwarded-for': '198.51.100.7',
        },
        body: JSON.stringify({ email: 'nobody@example.com', password: 'harbor-lantern-quiet-42' }),
      })
      statuses.push((await auth.handler(req)).status)
    }

    expect(statuses[3]).toBe(429)
  })
})
