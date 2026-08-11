/**
 * First-user bootstrap through the real Better Auth sign-up flow (ADR-038).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { user, auditLog } from '@kukan/db'
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

describe('first-user bootstrap', () => {
  it('promotes the first sign-up to sysadmin, audits it, and keeps later users regular', async () => {
    const auth = createAuth(db)

    await auth.api.signUpEmail({
      body: { email: 'first@example.com', password: 'harbor-lantern-quiet-42', name: 'first-user' },
    })
    const [first] = await db.select().from(user).where(eq(user.email, 'first@example.com'))
    expect(first.role).toBe('sysadmin')

    // The audit write runs in an after-transaction hook — allow it to flush
    let logs: (typeof auditLog.$inferSelect)[] = []
    for (let i = 0; i < 20 && logs.length === 0; i++) {
      logs = await db.select().from(auditLog).where(eq(auditLog.entityType, 'user'))
      if (logs.length === 0) await new Promise((r) => setTimeout(r, 50))
    }
    expect(logs).toHaveLength(1)
    expect(logs[0].changes).toMatchObject({
      userId: first.id,
      role: 'sysadmin',
      bootstrap: true,
    })

    await auth.api.signUpEmail({
      body: {
        email: 'second@example.com',
        password: 'harbor-lantern-quiet-42',
        name: 'second-user',
      },
    })
    const [second] = await db.select().from(user).where(eq(user.email, 'second@example.com'))
    expect(second.role).toBe('user')
  })

  it('promotes exactly one user under concurrent sign-ups', async () => {
    const auth = createAuth(db)

    // Claim-race losers are rejected with a retryable CONFLICT, so some
    // settle as rejected — never as extra sysadmins or claim-window users
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        auth.api.signUpEmail({
          body: {
            email: `race-${i}@example.com`,
            password: 'harbor-lantern-quiet-42',
            name: `race-${i}`,
          },
        })
      )
    )
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length
    expect(fulfilled).toBeGreaterThanOrEqual(1)

    const admins = await db.select().from(user).where(eq(user.role, 'sysadmin'))
    expect(admins).toHaveLength(1)
    const all = await db.select().from(user)
    expect(all).toHaveLength(fulfilled)
  })

  it('re-claims a stale leftover claim (failed first sign-up) and still promotes', async () => {
    // Simulate a first sign-up that claimed but died before creating its user
    await db.execute(sql`
      INSERT INTO system_setting (key, value, created, updated)
      VALUES ('bootstrap-completed', 'true'::jsonb, now() - interval '5 minutes',
              now() - interval '5 minutes')
    `)

    const auth = createAuth(db)
    await auth.api.signUpEmail({
      body: { email: 'retry@example.com', password: 'harbor-lantern-quiet-42', name: 'retry-user' },
    })
    const [retried] = await db.select().from(user).where(eq(user.email, 'retry@example.com'))
    expect(retried.role).toBe('sysadmin')
  })

  it('rejects sign-up while a fresh claim is in flight (retryable)', async () => {
    // A just-written claim (updated = now) must not be stolen — and the
    // sign-up must not create a user either, or bootstrap would end without
    // a sysadmin if the claim holder died mid-creation
    await db.execute(sql`
      INSERT INTO system_setting (key, value) VALUES ('bootstrap-completed', 'true'::jsonb)
    `)

    const auth = createAuth(db)
    await expect(
      auth.api.signUpEmail({
        body: { email: 'late@example.com', password: 'harbor-lantern-quiet-42', name: 'late-user' },
      })
    ).rejects.toThrow()

    expect(await db.select().from(user)).toHaveLength(0)
  })
})
