/**
 * Integration test database helpers.
 *
 * Connects to this worker's database, which globalSetup named and
 * prepareTestDatabase copies from the template.
 * Provides cleanDatabase() to TRUNCATE all tables between tests.
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import * as schema from '@kukan/db/schema'
import { inject } from 'vitest'
import {
  createTestDatabase,
  createTestPool,
  testDatabaseName,
  testDatabaseUrl,
  truncateTables,
} from '@kukan/db-testing'

/** This process's own database — see `@kukan/db-testing` for the naming. */
const name = () => testDatabaseName(inject('testDbPrefix'))

let pool: Pool | null = null
let db: ReturnType<typeof drizzle<typeof schema>> | null = null

/**
 * Make this process's database if it is not there.
 *
 * Called from a `beforeAll` the project installs, so it happens before anything
 * queries — `getTestDb` hands back a lazy pool, so a first query would
 * otherwise be the thing that discovered the database was missing.
 */
export async function prepareTestDatabase() {
  await createTestDatabase(name())
}

function getPool() {
  pool ??= createTestPool(testDatabaseUrl(name()))
  return pool
}

export function getTestDb() {
  db ??= drizzle(getPool(), { schema })
  return db
}

/**
 * A second handle on this process's pool that records the SQL it emits.
 *
 * The logger reports each statement with its placeholders still in it, which is
 * what {@link ../services/sql-shape.integration.test.ts} pins — the bound values
 * carry generated ids and timestamps and would not repeat between runs.
 */
export function createQueryRecorder() {
  const queries: string[] = []
  // Shares the pool rather than opening one, so its ceiling still holds
  const recorder = drizzle(getPool(), {
    schema,
    logger: { logQuery: (query) => queries.push(query) },
  })
  return { db: recorder, queries }
}

/**
 * Truncate all application tables (FK-safe with CASCADE).
 * Call in beforeEach() to ensure test isolation.
 *
 * Through `truncateTables` rather than the drizzle handle: a truncate cannot
 * share the pool with a query the previous test left running, and that is where
 * the reason lives.
 */
export async function cleanDatabase() {
  await truncateTables(getPool(), [
    'fetch_rate_limit',
    'job',
    'orphaned_object',
    'resource_pipeline_step',
    'resource_pipeline',
    'user_org_membership',
    'user_group_membership',
    'package_tag',
    'resource',
    'package',
    'tag',
    'vocabulary',
    'api_token',
    'audit_log',
    'activity',
    'announcement',
    'system_setting',
    'group',
    'organization',
  ])
}

/**
 * Clear the user table, which {@link cleanDatabase} leaves alone.
 *
 * Rows, not `TRUNCATE ... CASCADE`: the cascade reaches every table with a user
 * reference — packages included — and a suite that only needs the accounts gone
 * would take its neighbours' fixtures with it. Call `cleanDatabase()` first;
 * audit rows reference `user.id` with no ON DELETE action.
 */
export async function cleanUsers() {
  await getTestDb().execute(sql`DELETE FROM "user"`)
}

/** Default test user ID (matches test-app.ts defaultTestUser) */
export const TEST_USER_ID = '00000000-0000-0000-0000-000000000001'

/**
 * Ensure the default test user exists in the database.
 * Call in beforeEach() for tests that create organizations (auto-admin membership requires FK).
 */
export async function ensureTestUser() {
  const db = getTestDb()
  await db.execute(sql`
    INSERT INTO "user" (id, email, name, "emailVerified", role, state)
    VALUES (${TEST_USER_ID}, 'test-admin@example.com', 'test-admin', true, 'sysadmin', 'active')
    ON CONFLICT (id) DO NOTHING
  `)
}

/** Non-sysadmin outsider user ID for permission tests */
export const OUTSIDER_USER_ID = '00000000-0000-0000-0000-000000000099'

/**
 * Ensure the outsider test user exists in the database.
 * Call in beforeEach() for tests that need a non-sysadmin user.
 */
export async function ensureOutsiderUser() {
  const db = getTestDb()
  await db.execute(sql`
    INSERT INTO "user" (id, email, name, "emailVerified", role, state)
    VALUES (${OUTSIDER_USER_ID}, 'outsider@example.com', 'outsider', true, 'user', 'active')
    ON CONFLICT (id) DO NOTHING
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
