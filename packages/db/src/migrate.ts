/**
 * KUKAN Database Migration Utility
 * Runs Drizzle migrations under an advisory lock, with a bounded wait for
 * the table locks the DDL takes.
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Client } from 'pg'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** Advisory lock identifying "someone is migrating this database". */
const LOCK_NAMESPACE = 4771
const MIGRATION_LOCK = 1

/** SQLSTATE for a `lock_timeout` expiry. */
const LOCK_NOT_AVAILABLE = '55P03'

/**
 * How a migration waits for the table locks its DDL takes.
 *
 * `ALTER TABLE` needs ACCESS EXCLUSIVE, and every later query on that table
 * queues behind the waiting ALTER — so a single idle-in-transaction session
 * turns a millisecond of DDL into an outage of unbounded length. The wait is
 * bounded, and a timed-out attempt is retried after a pause rather than ending
 * the process: the session in the way is usually a legitimate one — a Worker
 * on the old image partway through an ingest holds ACCESS SHARE on
 * `resource_version` for tens of seconds — and a task that dies on the first
 * timeout dies on the next boots too, until the ECS circuit breaker rolls the
 * deployment back. The pause is what lets the queries that queued behind the
 * failed attempt drain before the next one. Twelve attempts of five seconds
 * with five between them is about two minutes, which is longer than an ingest.
 */
export interface MigrationOptions {
  /** `lock_timeout` on the DDL connections. */
  lockTimeoutMs?: number
  /** How many times the migration is attempted before giving up. */
  attempts?: number
  /** How long to wait between attempts. */
  retryDelayMs?: number
}

const DEFAULTS: Required<MigrationOptions> = {
  lockTimeoutMs: 5000,
  attempts: 12,
  retryDelayMs: 5000,
}

/**
 * Where this package keeps its migrations.
 *
 * Exported because the path is relative to this file, and that is the whole of
 * what the integration-test databases needed from here — they migrate a template
 * and read the journal to tell whether it is ahead. Everything else about them
 * lives in @kukan/db-testing, which no deployment installs.
 */
export const MIGRATIONS_FOLDER = resolve(__dirname, '../drizzle')

/** Whether an error, or anything it wraps, is a `lock_timeout` expiry. */
function isLockTimeout(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if ((e as { code?: unknown }).code === LOCK_NOT_AVAILABLE) return true
  }
  return false
}

/**
 * Run all pending database migrations.
 *
 * Safe to call from several processes at once — deployments do, since every
 * Worker task migrates at boot. The advisory lock makes the others wait where
 * they hold nothing, rather than in the queue for the tables being altered.
 */
export async function runMigrations(
  connectionString: string,
  options: MigrationOptions = {}
): Promise<void> {
  const { lockTimeoutMs, attempts, retryDelayMs } = { ...DEFAULTS, ...options }
  const ssl = process.env.POSTGRES_SSLMODE === 'require' ? { rejectUnauthorized: false } : undefined
  // One session for the lock and the DDL: the advisory lock lives exactly as
  // long as the connection, and the timeout set on it reaches every statement
  // the migration runs, with nothing handed back to a pool afterwards.
  const client = new Client({ connectionString, ...(ssl && { ssl }) })
  await client.connect()
  try {
    // Waiting for the turn to migrate is not the wait that hurts, so it is exempt
    await client.query("SELECT set_config('lock_timeout', '0', false)")
    await client.query('SELECT pg_advisory_lock($1, $2)', [LOCK_NAMESPACE, MIGRATION_LOCK])
    await client.query("SELECT set_config('lock_timeout', $1, false)", [String(lockTimeoutMs)])

    // Ensure required extensions exist (not managed by Drizzle)
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')

    console.log('[Migrate] Running migrations...')
    // Drizzle applies every pending migration in one transaction, so a timed-out
    // attempt leaves nothing half-done for the next to trip over.
    for (let attempt = 1; ; attempt++) {
      try {
        await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER })
        break
      } catch (err) {
        if (!isLockTimeout(err) || attempt >= attempts) throw err
        console.warn(
          `[Migrate] Attempt ${attempt}/${attempts} timed out waiting for a table lock; retrying in ${retryDelayMs}ms`
        )
        await sleep(retryDelayMs)
      }
    }
    console.log('[Migrate] Migrations complete!')
  } finally {
    // Ending the session releases the advisory lock with it
    await client.end()
  }
}
