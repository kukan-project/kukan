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
import { inject } from 'vitest'
import { createTestDatabase, testDatabaseName, testDatabaseUrl } from '@kukan/db/testing'

/** This pool slot's own database — see `@kukan/db/testing` for the naming. */
const name = () => testDatabaseName(inject('testDbPrefix'))

/**
 * Two per slot, not five.
 *
 * Parallel files multiply this by however many slots vitest opens — 23 on a
 * 24-core box — and a second run on the same machine doubles it again. At five
 * that was 115 potential connections a run against a server offering 97:
 * measured, two concurrent runs hit the ceiling and both failed with
 * `sorry, too many clients already`, reported as unrelated assertion failures.
 * A file's tests run one at a time, so two is more than the work needs.
 */
const POOL_MAX = 2

let pool: Pool | null = null
let db: ReturnType<typeof drizzle<typeof schema>> | null = null

/**
 * Make this slot's database if it is not there.
 *
 * Called from a `beforeAll` the project installs, so it happens before anything
 * queries — `getTestDb` hands back a lazy pool, so a first query would
 * otherwise be the thing that discovered the database was missing.
 */
export async function prepareTestDatabase() {
  await createTestDatabase(name())
}

export function getTestDb() {
  pool ??= new Pool({ connectionString: testDatabaseUrl(name()), max: POOL_MAX })
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
