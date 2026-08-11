/**
 * Password strength policy through the real Better Auth endpoints.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { user } from '@kukan/db'
import { PASSWORD_MIN_SCORE } from '@kukan/shared'
import {
  getTestDb,
  cleanDatabase,
  cleanUsers,
  closeTestDb,
  ensureTestUser,
} from '../test-helpers/test-db'
import { createAuth } from '../../auth/auth'
import { resetBootstrapCache } from '../../services/bootstrap'

// The shared setup opts out of scoring; this suite is what tests it
process.env.PASSWORD_MIN_SCORE = String(PASSWORD_MIN_SCORE)

const db = getTestDb()
const STRONG = 'harbor-lantern-quiet-42'

beforeEach(async () => {
  await cleanDatabase()
  await cleanUsers()
  resetBootstrapCache()
  // Seed a user so sign-ups here are not the bootstrap one (ADR-038): its audit
  // write lands in an after-transaction hook that would outlive the file and
  // collide with the next one's cleanup
  await ensureTestUser()
})

afterEach(() => {
  process.env.PASSWORD_MIN_SCORE = String(PASSWORD_MIN_SCORE)
})

afterAll(async () => {
  await closeTestDb()
})

describe('password strength policy', () => {
  it('rejects a guessable password at sign-up', async () => {
    const auth = createAuth(db)

    await expect(
      auth.api.signUpEmail({
        body: { email: 'weak@example.com', password: 'passwordpassword', name: 'weak-user' },
      })
    ).rejects.toMatchObject({ body: { code: 'PASSWORD_TOO_WEAK' } })
  })

  it('rejects a password derived from the account being created', async () => {
    const auth = createAuth(db)

    await expect(
      auth.api.signUpEmail({
        body: {
          email: 'taro-yamada@example.com',
          password: 'taro-yamada-2026-2026',
          name: 'taro-yamada',
        },
      })
    ).rejects.toMatchObject({ body: { code: 'PASSWORD_TOO_WEAK' } })
  })

  it('rejects a weak password on change, and accepts a strong one', async () => {
    const auth = createAuth(db)
    const signUp = await auth.api.signUpEmail({
      body: { email: 'changer@example.com', password: STRONG, name: 'changer' },
      asResponse: true,
    })
    const headers = new Headers({ cookie: signUp.headers.get('set-cookie') ?? '' })

    await expect(
      auth.api.changePassword({
        body: { currentPassword: STRONG, newPassword: 'passwordpassword' },
        headers,
      })
    ).rejects.toMatchObject({ body: { code: 'PASSWORD_TOO_WEAK' } })

    await expect(
      auth.api.changePassword({
        body: { currentPassword: STRONG, newPassword: 'copper-vault-drizzle-19' },
        headers,
      })
    ).resolves.toBeTruthy()
  })

  it('weighs the display name a change is made under', async () => {
    const auth = createAuth(db)
    const signUp = await auth.api.signUpEmail({
      body: { email: 'named@example.com', password: STRONG, name: 'u-8842' },
      asResponse: true,
    })
    const headers = new Headers({ cookie: signUp.headers.get('set-cookie') ?? '' })
    await db
      .update(user)
      .set({ displayName: 'copper-vault-drizzle' })
      .where(eq(user.email, 'named@example.com'))

    await expect(
      auth.api.changePassword({
        body: { currentPassword: STRONG, newPassword: 'copper-vault-drizzle-19' },
        headers,
      })
    ).rejects.toMatchObject({ body: { code: 'PASSWORD_TOO_WEAK' } })
  })

  it('weighs the display name a user is created with', async () => {
    const auth = createAuth(db)

    await expect(
      auth.api.createUser({
        body: {
          email: 'created@example.com',
          name: 'u-9913',
          password: 'copper-vault-drizzle-19',
          data: { displayName: 'copper-vault-drizzle' },
        },
      })
    ).rejects.toMatchObject({ body: { code: 'PASSWORD_TOO_WEAK' } })
  })

  it('refuses an over-long password by name, without scoring it', async () => {
    const auth = createAuth(db)
    // Scoring is superlinear in length, and this hook runs ahead of Better
    // Auth's own length check — an unauthenticated caller could otherwise buy
    // seconds of blocking CPU per request
    const huge = 'p@ssw0rd h0rs3 b@tt3ry st@pl3 '.repeat(1000)

    await expect(
      auth.api.signUpEmail({
        body: { email: 'huge@example.com', password: huge, name: 'huge-user' },
      })
    ).rejects.toMatchObject({ body: { code: 'PASSWORD_TOO_LONG' } })
  })

  it('refuses a too-short password by name, not as a weak one', async () => {
    const auth = createAuth(db)

    await expect(
      auth.api.signUpEmail({
        body: { email: 'short@example.com', password: 'x7$Qm2', name: 'short-user' },
      })
    ).rejects.toMatchObject({ body: { code: 'PASSWORD_TOO_SHORT' } })
  })

  it('accepts a guessable password when the environment lowers the score floor', async () => {
    process.env.PASSWORD_MIN_SCORE = '0'
    const auth = createAuth(db)

    await expect(
      auth.api.signUpEmail({
        body: { email: 'relaxed@example.com', password: 'passwordpassword', name: 'relaxed-user' },
      })
    ).resolves.toBeTruthy()
  })

  it('keeps the length floor even with the score floor at zero', async () => {
    process.env.PASSWORD_MIN_SCORE = '0'
    const auth = createAuth(db)

    await expect(
      auth.api.signUpEmail({
        body: { email: 'floor@example.com', password: 'x7$Qm2', name: 'floor-user' },
      })
    ).rejects.toMatchObject({ body: { code: 'PASSWORD_TOO_SHORT' } })
  })

  it('counts a floor-length password of emoji for what it is', async () => {
    const auth = createAuth(db)

    await expect(
      auth.api.signUpEmail({
        body: { email: 'emoji@example.com', password: '😀'.repeat(8), name: 'emoji-user' },
      })
    ).rejects.toMatchObject({ body: { code: 'PASSWORD_TOO_SHORT' } })
  })
})
