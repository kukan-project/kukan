/**
 * KUKAN Database Client
 * Drizzle ORM client factory
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'
import { pgSsl } from './ssl'

export interface DbPoolOptions {
  max?: number
  idleTimeoutMillis?: number
  connectionTimeoutMillis?: number
}

const globalForPool = globalThis as unknown as { __kukanPool?: Pool }

export function createDb(connectionString: string, poolOptions?: DbPoolOptions) {
  // In development, reuse the pool across HMR to prevent connection leaks
  if (process.env.NODE_ENV !== 'production' && globalForPool.__kukanPool) {
    return drizzle(globalForPool.__kukanPool, { schema })
  }

  const ssl = pgSsl()
  const pool = new Pool({ connectionString, ...poolOptions, ...(ssl && { ssl }) })
  globalForPool.__kukanPool = pool
  return drizzle(pool, { schema })
}

/** Close the cached pool (for graceful shutdown) */
export async function closePool(): Promise<void> {
  if (globalForPool.__kukanPool) {
    await globalForPool.__kukanPool.end()
    globalForPool.__kukanPool = undefined
  }
}

export type Database = ReturnType<typeof createDb>

/** The handle a `db.transaction(...)` callback receives. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
