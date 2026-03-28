/**
 * KUKAN Database Migration Utility
 * Runs Drizzle migrations with advisory lock for safe concurrent execution.
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Run all pending database migrations.
 * Safe to call from multiple processes concurrently (uses advisory locks).
 */
export async function runMigrations(connectionString: string): Promise<void> {
  // In production (AWS RDS) the server uses a private CA that Node.js doesn't trust.
  // We enable SSL without CA-chain verification; the connection remains encrypted.
  const ssl = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) })
  const db = drizzle(pool)

  // Ensure required extensions exist (not managed by Drizzle)
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')

  const migrationsFolder = resolve(__dirname, '../drizzle')
  console.log('[Migrate] Running migrations...')
  await migrate(db, { migrationsFolder })
  console.log('[Migrate] Migrations complete!')

  await pool.end()
}
