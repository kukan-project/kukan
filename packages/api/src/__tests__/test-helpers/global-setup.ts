/**
 * Vitest globalSetup for integration tests.
 *
 * 1. Creates kukan_test database if it doesn't exist
 * 2. Runs Drizzle migrations against kukan_test
 */
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const BASE_URL = process.env.DATABASE_URL || 'postgresql://kukan:kukan@localhost:5432/kukan'
const TEST_DB_NAME = 'kukan_test'
const TEST_URL =
  process.env.TEST_DATABASE_URL || `postgresql://kukan:kukan@localhost:5432/${TEST_DB_NAME}`

export async function setup() {
  // Step 1: Create test database if it doesn't exist
  const adminPool = new Pool({ connectionString: BASE_URL })
  try {
    const result = await adminPool.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [
      TEST_DB_NAME,
    ])
    if (result.rowCount === 0) {
      await adminPool.query(`CREATE DATABASE ${TEST_DB_NAME}`)
      console.log(`Created database: ${TEST_DB_NAME}`)
    }
  } finally {
    await adminPool.end()
  }

  // Step 2: Run migrations
  const migratePool = new Pool({ connectionString: TEST_URL })
  try {
    // Ensure required extensions exist before running migrations
    await migratePool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')

    const db = drizzle(migratePool)
    // __dirname = packages/api/src/__tests__/test-helpers
    // 5 levels up to monorepo root
    const migrationsFolder = resolve(__dirname, '../../../../../packages/db/drizzle')
    await migrate(db, { migrationsFolder })
    console.log('Test database migrations complete')
  } finally {
    await migratePool.end()
  }
}
