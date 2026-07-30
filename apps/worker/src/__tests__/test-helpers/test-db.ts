/**
 * Integration test database helpers for the worker.
 *
 * The worker holds raw SQL of its own — the step tracker's parking CTEs and the
 * orphan sweep's reference check — and neither can be exercised by a mock: one
 * is a statement Postgres either parses or does not, the other decides what
 * gets deleted. They need a database, so the worker gets the same harness the
 * API's integration tests use, against a database of its own.
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import { Pool } from 'pg'
import * as schema from '@kukan/db/schema/index'
import { testDatabaseUrl } from '@kukan/db/testing'
import { WORKER_TEST_DB } from './global-setup'

const TEST_DATABASE_URL = testDatabaseUrl(WORKER_TEST_DB)

let pool: Pool | null = null
let db: ReturnType<typeof drizzle<typeof schema>> | null = null

export function getTestDb() {
  pool ??= new Pool({ connectionString: TEST_DATABASE_URL, max: 5 })
  db ??= drizzle(pool, { schema })
  return db
}

/** Truncate the tables these tests touch. Call in beforeEach(). */
export async function cleanDatabase() {
  await getTestDb().execute(sql`
    TRUNCATE TABLE
      orphaned_object, resource_pipeline_step, resource_pipeline,
      resource_version, resource, package
    CASCADE
  `)
}

/** Close the connection pool. Call in afterAll() of the top-level suite. */
export async function closeTestDb() {
  if (pool) {
    await pool.end()
    pool = null
    db = null
  }
}
