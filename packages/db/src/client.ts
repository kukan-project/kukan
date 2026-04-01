/**
 * KUKAN Database Client
 * Drizzle ORM client factory
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

export interface DbPoolOptions {
  max?: number
  idleTimeoutMillis?: number
  connectionTimeoutMillis?: number
}

const globalForPool = globalThis as unknown as { __kukanPool?: Pool }

export function createDb(connectionString: string, poolOptions?: DbPoolOptions) {
  // POSTGRES_SSLMODE=require → SSL without CA verification (for RDS/Aurora)
  const ssl = process.env.POSTGRES_SSLMODE === 'require' ? { rejectUnauthorized: false } : undefined

  // In development, reuse the pool across HMR to prevent connection leaks
  if (process.env.NODE_ENV !== 'production' && globalForPool.__kukanPool) {
    return drizzle(globalForPool.__kukanPool, { schema })
  }

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
