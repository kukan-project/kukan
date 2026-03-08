/**
 * Integration test database helpers.
 *
 * Connects to kukan_test database (created by globalSetup).
 * Provides cleanDatabase() to TRUNCATE all tables between tests.
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import { Pool } from 'pg'
import * as schema from '@kukan/db/schema/index'

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://kukan:kukan@localhost:5432/kukan_test'

let pool: Pool | null = null
let db: ReturnType<typeof drizzle<typeof schema>> | null = null

export function getTestDb() {
  if (!pool) {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 })
  }
  if (!db) {
    db = drizzle(pool, { schema })
  }
  return db
}

/**
 * Truncate all application tables (FK-safe with CASCADE).
 * Call in beforeEach() to ensure test isolation.
 */
export async function cleanDatabase() {
  const db = getTestDb()
  await db.execute(sql`
    TRUNCATE TABLE
      package_tag, resource, package, tag, vocabulary,
      api_token, audit_log, activity,
      "group", organization
    CASCADE
  `)
}

/**
 * Close the connection pool. Call in afterAll() of the top-level suite.
 */
export async function closeTestDb() {
  if (pool) {
    await pool.end()
    pool = null
    db = null
  }
}
