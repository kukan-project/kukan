/** Blocking advisory locks: one caller per process waits in the database at a time. */
import { describe, it, expect, afterAll } from 'vitest'
import type { Database } from '@kukan/db'
import { withAdvisoryLock } from '../../services/advisory-lock'
import { getTestDb, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()

afterAll(async () => {
  await closeTestDb()
})

/** `db`, counting the transactions open on it at once. */
function counting() {
  let open = 0
  let most = 0
  const wrapped = {
    transaction: async (fn: Parameters<Database['transaction']>[0]) => {
      most = Math.max(most, ++open)
      try {
        return await db.transaction(fn)
      } finally {
        open--
      }
    },
  } as unknown as Database
  return { db: wrapped, most: () => most }
}

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}

describe('withAdvisoryLock', () => {
  it('lets a second caller for the same lock take no connection until the first is done', async () => {
    const { db: tracked, most } = counting()
    const held = gate()
    const order: string[] = []

    const first = withAdvisoryLock(tracked, 'test_lock', 'a', async () => {
      order.push('first in')
      await held.opened
      order.push('first out')
    })
    const second = withAdvisoryLock(tracked, 'test_lock', 'a', async () => {
      order.push('second in')
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    held.open()
    await Promise.all([first, second])

    expect(order).toEqual(['first in', 'first out', 'second in'])
    expect(most()).toBe(1)
  })

  it('runs callers for different locks side by side', async () => {
    const { db: tracked, most } = counting()
    const held = gate()
    const a = withAdvisoryLock(tracked, 'test_lock', 'a', () => held.opened)
    const b = withAdvisoryLock(tracked, 'test_lock', 'b', () => held.opened)
    await new Promise((resolve) => setTimeout(resolve, 100))
    held.open()
    await Promise.all([a, b])

    expect(most()).toBe(2)
  })
})
