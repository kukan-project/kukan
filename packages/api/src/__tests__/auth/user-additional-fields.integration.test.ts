/**
 * KUKAN columns on the user table only reach the row when Better Auth is told
 * about them, and nothing fails loudly when it is not.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { session, user } from '@kukan/db'
import { createLogger } from '@kukan/shared'
import {
  getTestDb,
  cleanDatabase,
  cleanUsers,
  closeTestDb,
  ensureTestUser,
} from '../test-helpers/test-db'
import { createAuth, type Auth } from '../../auth/auth'
import { optionalAuth } from '../../middleware/auth'
import { usersRouter } from '../../routes/users'
import { resetBootstrapCache } from '../../services/bootstrap'
import { UserService } from '../../services/user-service'

const db = getTestDb()

beforeEach(async () => {
  await cleanDatabase()
  await cleanUsers()
  resetBootstrapCache()
  await ensureTestUser()
})

afterAll(async () => {
  await closeTestDb()
})

/** Session auth as app.ts wires it, in front of the users routes. */
function createSessionApp(auth: Auth) {
  const app = new Hono()
  const logger = createLogger({ name: 'test', level: 'silent' })
  app.use('*', async (c, next) => {
    c.set('db', db)
    c.set('logger', logger)
    await next()
  })
  app.use('*', optionalAuth(auth))
  app.route('/api/v1/users', usersRouter)
  return app
}

describe('user additional fields', () => {
  it('persists a displayName handed to createUser', async () => {
    const auth = createAuth(db, 'x-forwarded-for')
    await auth.api.createUser({
      body: {
        name: 'display-test',
        email: 'display-test@example.com',
        password: 'harbor-lantern-quiet-42',
        data: { displayName: '表示 太郎' },
      },
    })
    const [row] = await db.select().from(user).where(eq(user.email, 'display-test@example.com'))
    expect(row.displayName).toBe('表示 太郎')
  })

  it('refuses a displayName a user sets on themselves', async () => {
    const auth = createAuth(db, 'x-forwarded-for')
    const signUp = await auth.api.signUpEmail({
      body: { email: 'self@example.com', password: 'harbor-lantern-quiet-42', name: 'self-user' },
      asResponse: true,
    })
    const headers = new Headers({ cookie: signUp.headers.get('set-cookie') ?? '' })

    // Through the HTTP surface an attacker would use, not the typed API — which
    // no longer offers the field either. Declaring the column to Better Auth
    // would otherwise let anyone signed in name themselves anything;
    // who may set it is KUKAN's admin API's call
    const res = await auth.handler(
      new Request('http://localhost:3000/api/auth/update-user', {
        method: 'POST',
        headers: { cookie: headers.get('cookie') ?? '', 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'システム管理者' }),
      })
    )
    expect(res.ok).toBe(false)

    const [row] = await db.select().from(user).where(eq(user.email, 'self@example.com'))
    expect(row.displayName).toBeNull()
  })

  it('turns away the session of a user deleted after signing in', async () => {
    const auth = createAuth(db, 'x-forwarded-for')
    const signUp = await auth.api.signUpEmail({
      body: { email: 'gone@example.com', password: 'harbor-lantern-quiet-42', name: 'gone-user' },
      asResponse: true,
    })
    const cookie = signUp.headers.get('set-cookie') ?? ''
    const app = createSessionApp(auth)

    expect((await app.request('/api/v1/users/me', { headers: { cookie } })).status).toBe(200)

    // The row alone, leaving the session as a failed revocation would
    await db.update(user).set({ state: 'deleted' }).where(eq(user.email, 'gone@example.com'))

    expect((await app.request('/api/v1/users/me', { headers: { cookie } })).status).toBe(401)
  })

  it("keeps Better Auth's own routes from a user deleted after signing in", async () => {
    const auth = createAuth(db, 'x-forwarded-for')
    const password = 'harbor-lantern-quiet-42'
    const signUp = await auth.api.signUpEmail({
      body: { email: 'lingering@example.com', password, name: 'lingering-user' },
      asResponse: true,
    })
    const cookie = signUp.headers.get('set-cookie') ?? ''
    // The row alone, as a sign-in racing the deletion would leave it
    await db.update(user).set({ state: 'deleted' }).where(eq(user.email, 'lingering@example.com'))

    const changePassword = await auth.handler(
      new Request('http://localhost:3000/api/auth/change-password', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword: password, newPassword: 'meadow-copper-signal-77' }),
      })
    )
    expect(changePassword.status).toBe(401)
    expect(await db.$count(session)).toBe(0)
  })

  it('answers get-session with nothing for a user deleted after signing in', async () => {
    const auth = createAuth(db, 'x-forwarded-for')
    const signUp = await auth.api.signUpEmail({
      body: {
        email: 'lingering@example.com',
        password: 'harbor-lantern-quiet-42',
        name: 'lingering-user',
      },
      asResponse: true,
    })
    const cookie = signUp.headers.get('set-cookie') ?? ''
    await db.update(user).set({ state: 'deleted' }).where(eq(user.email, 'lingering@example.com'))

    const res = await auth.handler(
      new Request('http://localhost:3000/api/auth/get-session', { headers: { cookie } })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toBeNull()
    expect(await db.$count(session)).toBe(0)
  })

  it('refuses a deleted user signing in again', async () => {
    const auth = createAuth(db, 'x-forwarded-for')
    const credentials = { email: 'returning@example.com', password: 'harbor-lantern-quiet-42' }
    const created = await auth.api.signUpEmail({ body: { ...credentials, name: 'returning-user' } })
    await new UserService(db).delete(created.user.id)

    const res = await auth.handler(
      new Request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(credentials),
      })
    )
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('USER_INACTIVE')
    expect(await db.$count(session, eq(session.userId, created.user.id))).toBe(0)
  })

  it('refuses a state set at sign-up', async () => {
    const auth = createAuth(db, 'x-forwarded-for')
    const signUp = (extra: Record<string, unknown>) =>
      auth.handler(
        new Request('http://localhost:3000/api/auth/sign-up/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'stateful@example.com',
            password: 'harbor-lantern-quiet-42',
            name: 'stateful-user',
            ...extra,
          }),
        })
      )

    const refused = await signUp({ state: 'deleted' })
    expect(refused.status).toBe(400)
    expect((await refused.json()).code).toBe('FIELD_NOT_ALLOWED')
    expect(await db.$count(user, eq(user.email, 'stateful@example.com'))).toBe(0)

    // The same sign-up without the field, so the refusal is the field's
    expect((await signUp({})).ok).toBe(true)
  })
})
