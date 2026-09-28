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
 * Truncate the tables these tests touch. Call in beforeEach().
 *
 * Through `truncateTables` rather than the drizzle handle: a truncate cannot
 * share the pool with a query the previous test left running, and that is where
 * the reason lives.
 */
export async function cleanDatabase() {
  await truncateTables(getPool(), [
    'job',
    'orphaned_object',
    'resource_pipeline_step',
    'resource_pipeline',
    'resource_version',
    'resource',
    'package',
    'tag',
  ])
}

/** Close the connection pool. Call in afterAll() of the top-level suite. */
export async function closeTestDb() {
  if (pool) {
    await pool.end()
    pool = null
    db = null
  }
}
