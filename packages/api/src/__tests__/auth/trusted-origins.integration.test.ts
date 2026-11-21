/**
 * Sign-in on a site's other names (additionalDomainNames). BETTER_AUTH_URL
 * stays the name of record; the others reach the app as TRUSTED_ORIGINS, which
 * Better Auth's origin check must take for the site's own.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'

// Better Auth skips its origin check under NODE_ENV=test or TEST, read once as
// it loads; this file checks the origin as a deployed site does
vi.hoisted(() => {
  process.env.NODE_ENV = 'development'
  delete process.env.TEST
})
import { getTestDb, cleanDatabase, cleanUsers, closeTestDb } from '../test-helpers/test-db'
import { createAuth } from '../../auth/auth'
import { resetBootstrapCache } from '../../services/bootstrap'

const db = getTestDb()
const RECORD = 'https://catalog.snow.example.org'
const OTHER = 'https://opendata.city.example.jp'

beforeEach(async () => {
  await cleanDatabase()
  await cleanUsers()
  resetBootstrapCache()
  vi.stubEnv('BETTER_AUTH_URL', RECORD)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

afterAll(async () => {
  await closeTestDb()
})

/** A sign-in from a browser on `origin`, carrying a cookie of an earlier visit. */
function signInFrom(origin: string) {
  return new Request(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      cookie: 'kukan-locale=ja',
    },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'harbor-lantern-quiet-42' }),
  })
}

/** Better Auth's answer to a sign-in from `origin`: 403 when it refuses the origin. */
async function signInStatus(origin: string): Promise<number> {
  const auth = createAuth(db, 'x-forwarded-for')
  return (await auth.handler(signInFrom(origin))).status
}

describe('sign-in on another name of the site', () => {
  it('is refused while the name is not among TRUSTED_ORIGINS', async () => {
    expect(await signInStatus(OTHER)).toBe(403)
  })

  it('reaches the credential check once it is', async () => {
    vi.stubEnv('TRUSTED_ORIGINS', OTHER)
    // 401: no such user — past the origin check
    expect(await signInStatus(OTHER)).toBe(401)
  })

  it('is taken on the name of record either way', async () => {
    expect(await signInStatus(RECORD)).toBe(401)
  })
})
