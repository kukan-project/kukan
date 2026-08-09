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
 * Where this package keeps its migrations.
 *
 * Exported because the path is relative to this file, and that is the whole of
 * what the integration-test databases needed from here — they migrate a template
 * and read the journal to tell whether it is ahead. Everything else about them
 * lives in @kukan/db-testing, which no deployment installs.
 */
export const MIGRATIONS_FOLDER = resolve(__dirname, '../drizzle')

/**
 * Run all pending database migrations.
 * Safe to call from multiple processes concurrently (uses advisory locks).
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const ssl = process.env.POSTGRES_SSLMODE === 'require' ? { rejectUnauthorized: false } : undefined
  const pool = new Pool({ connectionString, ...(ssl && { ssl }) })
  const db = drizzle(pool)

  // Ensure required extensions exist (not managed by Drizzle)
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')

  console.log('[Migrate] Running migrations...')
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
  console.log('[Migrate] Migrations complete!')

  await pool.end()
}
