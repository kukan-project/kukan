/**
 * `name` is KUKAN's unique username, and only sysadmin may change it (PATCH
 * /api/v1/admin/users/:userId). Better Auth mounts its own route for the same
 * column, open to anyone signed in and applying none of KUKAN's rules.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { user } from '@kukan/db'
import {
  getTestDb,
  cleanDatabase,
  cleanUsers,
  closeTestDb,
  ensureTestUser,
} from '../test-helpers/test-db'
import { createAuth, type Auth } from '../../auth/auth'
import { authSurface } from '../../middleware/auth-surface'
import { errorHandler } from '../../middleware/error-handler'
import { resetBootstrapCache } from '../../services/bootstrap'

const db = getTestDb()

let auth: Auth
let cookie: string

beforeEach(async () => {
  await cleanDatabase()
  await cleanUsers()
  resetBootstrapCache()
  await ensureTestUser()

  auth = createAuth(db)
  const signUp = await auth.api.signUpEmail({
    body: { email: 'renamer@example.com', password: 'harbor-lantern-quiet-42', name: 'renamer' },
    asResponse: true,
  })
  cookie = signUp.headers.get('set-cookie') ?? ''
})

afterAll(async () => {
  await closeTestDb()
})

/** The /api/auth wiring from app.ts, without the rest of the application. */
function createAuthApp() {
  const app = new Hono()
  app.use('/api/auth/*', authSurface)
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  app.onError(errorHandler)
  return app
}

function renameRequest(name: string) {
  return new Request('http://localhost:3000/api/auth/update-user', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

async function nameOf(email: string) {
  const [row] = await db.select().from(user).where(eq(user.email, email))
  return row.name
}

describe('POST /api/auth/update-user', () => {
  it('refuses a signed-in user renaming themselves', async () => {
    const res = await createAuthApp().request(renameRequest('CLAIMED BY ME'))

    // 404 rather than 403: a refusal would confirm the endpoint is there
    expect(res.status).toBe(404)
    expect(await nameOf('renamer@example.com')).toBe('renamer')
  })

  it('is live underneath the block', async () => {
    // Straight to the auth handler, as app.ts did before the middleware. Fails
    // if Better Auth ever closes this itself, at which point the guard is only
    // documentation
    const res = await auth.handler(renameRequest('CLAIMED BY ME'))

    expect(res.ok).toBe(true)
    expect(await nameOf('renamer@example.com')).toBe('CLAIMED BY ME')
  })
})
