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

export function createDb(connectionString: string, poolOptions?: DbPoolOptions) {
  // POSTGRES_SSLMODE=require → SSL without CA verification (for RDS/Aurora)
  const ssl = process.env.POSTGRES_SSLMODE === 'require' ? { rejectUnauthorized: false } : undefined
  const pool = new Pool({ connectionString, ...poolOptions, ...(ssl && { ssl }) })
  return drizzle(pool, { schema })
}

export type Database = ReturnType<typeof createDb>
