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
  // In production (AWS RDS) the server uses a private CA that Node.js doesn't trust.
  // We enable SSL without CA-chain verification; the connection remains encrypted.
  const ssl = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}), ...poolOptions })
  return drizzle(pool, { schema })
}

export type Database = ReturnType<typeof createDb>
