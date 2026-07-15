/**
 * Integration tests for per-package resource position serialization.
 *
 * create() assigns position = MAX + 1 inside its transaction, which races
 * under READ COMMITTED; a per-package advisory lock (lockResourcePositions)
 * serializes the assignment. These tests run genuinely concurrent creates
 * against real PostgreSQL to verify the lock, which unit-test mocks cannot.
 *
 * Note: reorder() acquires the same lock, but the create-vs-reorder overlap
 * is not exercised here (it needs a held-open renumbering transaction).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { ResourceService } from '../../services/resource-service'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const service = new ResourceService(db)

let packageId: string

beforeEach(async () => {
  await cleanDatabase()
  const pkgResult = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-positions', 'active') RETURNING id
  `)
  packageId = (pkgResult.rows[0] as { id: string }).id
})

afterAll(async () => {
  await closeTestDb()
})

describe('concurrent resource creation', () => {
  it('assigns distinct sequential positions', async () => {
    const COUNT = 8
    const created = await Promise.all(
      Array.from({ length: COUNT }, (_, i) =>
        service.create({ packageId, name: `res-${i}`, state: 'active' })
      )
    )

    const positions = created.map((r) => r.position).sort((a, b) => a - b)
    expect(positions).toEqual(Array.from({ length: COUNT }, (_, i) => i))
  })

  it('does not serialize creates across different packages', async () => {
    const otherResult = await db.execute(sql`
      INSERT INTO package (name, state) VALUES ('test-pkg-positions-2', 'active') RETURNING id
    `)
    const otherId = (otherResult.rows[0] as { id: string }).id

    // Hold package A's position lock in an open transaction. The key must
    // mirror lockResourcePositions — if the service's key format changes,
    // the blocked-create assertion below starts failing and flags it.
    let signalAcquired!: () => void
    const acquired = new Promise<void>((resolve) => (signalAcquired = resolve))
    let releaseLock!: () => void
    const gate = new Promise<void>((resolve) => (releaseLock = resolve))
    const holder = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${'resource_position:' + packageId}, 0))`
      )
      signalAcquired()
      await gate
    })

    try {
      await acquired

      // Package B's create must complete while A's lock is held — a lock
      // that is accidentally global would block it (fail fast, not time out)
      const b = (await Promise.race([
        service.create({ packageId: otherId, name: 'res-b', state: 'active' }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('create on package B was blocked by package A lock')),
            2000
          )
        ),
      ])) as Awaited<ReturnType<typeof service.create>>
      expect(b.position).toBe(0)

      // ...while a create on package A itself stays blocked on the lock
      let aSettled = false
      const aPromise = service
        .create({ packageId, name: 'res-a', state: 'active' })
        .then((resource) => {
          aSettled = true
          return resource
        })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(aSettled).toBe(false)

      releaseLock()
      await holder
      const a = await aPromise
      expect(a.position).toBe(0)
    } finally {
      // Never leave the lock-holding transaction open on assertion failure
      releaseLock()
      await holder.catch(() => {})
    }
  })
})
