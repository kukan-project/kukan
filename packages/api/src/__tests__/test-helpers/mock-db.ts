/**
 * Drizzle ORM mock helper for unit tests.
 *
 * Uses Proxy to handle deep method chaining like:
 *   db.select().from(table).where(cond).limit(1)
 *
 * Usage:
 *   const { db, addResult } = createMockDb()
 *   addResult([{ id: '1', name: 'test' }])  // first query returns this
 *   addResult([{ total: 5 }])                // second query returns this
 *   const service = new SomeService(db)
 */
import { vi } from 'vitest'
import type { Database } from '@kukan/db'

export function createMockDb() {
  const results: unknown[][] = []
  let callIndex = 0

  function createChain(): unknown {
    return new Proxy(() => {}, {
      get(_target, prop) {
        // When awaited, Promises call .then()
        if (prop === 'then') {
          const result = results[callIndex++] ?? []
          return (resolve: (value: unknown) => void) => resolve(result)
        }
        // .returning() is a terminal that returns a promise
        if (prop === 'returning') {
          return () => {
            const result = results[callIndex++] ?? []
            return Promise.resolve(result)
          }
        }
        // All other methods return the chain to allow continued chaining
        return vi.fn(() => createChain())
      },
      apply() {
        return createChain()
      },
    })
  }

  const db = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'transaction') {
          return vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
            // Transaction receives the same mock db (simplified)
            return fn(db)
          })
        }
        if (prop === 'execute') {
          return vi.fn(async () => {
            return results[callIndex++] ?? []
          })
        }
        // select, insert, update, delete all return chain
        return vi.fn(() => createChain())
      },
    }
  ) as unknown as Database

  return {
    db,
    /** Queue a result for the next query. Results are consumed in order. */
    addResult(result: unknown[]) {
      results.push(result)
    },
    /** Reset call index and results */
    reset() {
      results.length = 0
      callIndex = 0
    },
  }
}
