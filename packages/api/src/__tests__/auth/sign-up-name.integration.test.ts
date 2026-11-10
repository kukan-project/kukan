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

  it('refuses a name already taken as a 422 the form can tell apart, not a 500', async () => {
    const auth = createAuth(db, 'x-forwarded-for')
    await auth.api.signUpEmail({
      body: { email: 'first@example.com', password: PASSWORD, name: 'same-name' },
    })

    await expect(
      auth.api.signUpEmail({
        body: { email: 'second@example.com', password: PASSWORD, name: 'same-name' },
      })
    ).rejects.toMatchObject({ statusCode: 422, body: { code: 'USER_NAME_TAKEN' } })
  })

  it("leaves signing up again with one's own email to the email check", async () => {
    const auth = createAuth(db, 'x-forwarded-for')
    await auth.api.signUpEmail({
      body: { email: 'again@example.com', password: PASSWORD, name: 'again-user' },
    })

    await expect(
      auth.api.signUpEmail({
        body: { email: 'again@example.com', password: PASSWORD, name: 'again-user' },
      })
    ).rejects.not.toMatchObject({ body: { code: 'USER_NAME_TAKEN' } })
  })

  it('refuses a taken name the admin API asks for too', async () => {
    const auth = createAuth(db, 'x-forwarded-for')
    await auth.api.signUpEmail({
      body: { email: 'owner@example.com', password: PASSWORD, name: 'held-name' },
    })

    await expect(
      auth.api.createUser({
        body: { email: 'other@example.com', password: PASSWORD, name: 'held-name' },
      })
    ).rejects.toMatchObject({ statusCode: 422, body: { code: 'USER_NAME_TAKEN' } })
  })
})
