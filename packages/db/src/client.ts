/**
 * KUKAN Database Client
 * Drizzle ORM client factory
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString })
  return drizzle(pool, { schema })
}

export type Database = ReturnType<typeof createDb>
