/**
 * The sign-up name rule through the real Better Auth endpoint.
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
const PASSWORD = 'harbor-lantern-quiet-42'

beforeEach(async () => {
  await cleanDatabase()
  await cleanUsers()
  resetBootstrapCache()
  // Not the bootstrap sign-up (ADR-038), whose audit write outlives the file
  await ensureTestUser()
})

afterAll(async () => {
  await closeTestDb()
})

describe('sign-up name', () => {
  it('refuses a name the sign-up form would not send, and creates no user', async () => {
    const auth = createAuth(db, 'x-forwarded-for')

    await expect(
      auth.api.signUpEmail({
        body: { email: 'evil@example.com', password: PASSWORD, name: 'Evil User' },
      })
    ).rejects.toMatchObject({ statusCode: 400, body: { code: 'INVALID_USER_NAME' } })

    const rows = await db.select().from(user).where(eq(user.email, 'evil@example.com'))
    expect(rows).toHaveLength(0)
  })

  it('accepts a slug name', async () => {
    const auth = createAuth(db, 'x-forwarded-for')

    const signUp = await auth.api.signUpEmail({
      body: { email: 'slug@example.com', password: PASSWORD, name: 'slug-user' },
    })
    expect(signUp.user.name).toBe('slug-user')
  })
})
