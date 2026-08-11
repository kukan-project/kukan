/**
 * KUKAN columns on the user table only reach the row when Better Auth is told
 * about them, and nothing fails loudly when it is not.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { user } from '@kukan/db'
import {
  getTestDb,
  cleanDatabase,
  cleanUsers,
  closeTestDb,
  ensureTestUser,
} from '../test-helpers/test-db'
import { createAuth } from '../../auth/auth'
import { resetBootstrapCache } from '../../services/bootstrap'

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

describe('user additional fields', () => {
  it('persists a displayName handed to createUser', async () => {
    const auth = createAuth(db)
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
    const auth = createAuth(db)
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
})
