/**
 * The scratch databases these tests make, dropped when the run ends.
 *
 * Not from an `afterAll`: measured, a drop issued while the other integration
 * projects are still copying databases of their own waits past twenty seconds
 * and leaks the database anyway — `CREATE DATABASE` and `DROP DATABASE` both
 * checkpoint, and eight forks keep the cluster doing it. By teardown the server
 * is quiet and the same drop takes milliseconds.
 *
 * Named for the run, as @kukan/db-testing names its databases — that package
 * depends on this one, so the scheme is repeated here rather than imported. A
 * name keyed on the pid alone let a second run on the same server drop this
 * one's database mid-test: pids are unique on a machine, but a sweep cannot
 * tell a live pid from a finished one, and a name is all it has to go on.
 * The run holds an advisory lock on its token for as long as the process
 * lives, so "can I take that lock?" is proof the run is gone — which is how a
 * run killed before teardown gets its database reclaimed by the next one, and
 * how a run still going keeps it.
 */
import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import type { TestProject } from 'vitest/node'
import { databaseUrl } from '@kukan/shared'

declare module 'vitest' {
  interface ProvidedContext {
    /** This run's scratch prefix; a test appends its pid. */
    migrateScratchPrefix: string
  }
}

/**
 * `kukan_migrate_lock_<token>_<pid>`, the token 8 base-36 characters of
 * creation time and 12 hex of randomness — fixed-width so that nothing hand-made
 * matches the sweep.
 */
const SCRATCH_PREFIX = 'kukan_migrate_lock'
const NAME = /^kukan_migrate_lock_([0-9a-z]{8}[0-9a-f]{12})_\d+$/
const NAME_SQL = '^kukan_migrate_lock_[0-9a-z]{8}[0-9a-f]{12}_[0-9]+$'

/** Advisory locks are (int, int); this half keeps ours apart from db-testing's. */
const LOCK_NAMESPACE = 4772

/** A run's token, as an advisory-lock key. A collision reads as "alive" — the safe direction. */
function lockKey(token: string): number {
  let hash = 0
  for (let i = 0; i < token.length; i++) hash = (Math.imul(hash, 31) + token.charCodeAt(i)) | 0
  return hash
}

export function scratchUrl(database: string): string {
  const url = new URL(databaseUrl())
  url.pathname = `/${database}`
  return url.toString()
}

/** Where a Postgres that can be treated as disposable lives. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * Refuse to work on a server that is not this machine's — the same guard, and
 * the same escape hatch, as @kukan/db-testing. This project has one file and
 * globs first, so its setup can run before the other suites' guard has said no.
 */
function refuseRemoteServer(): void {
  if (process.env.KUKAN_TEST_DB_ALLOW_REMOTE === '1') return
  // `hostname` brackets an IPv6 literal; the set holds bare addresses.
  const host = new URL(databaseUrl()).hostname.replace(/^\[|\]$/g, '')
  if (LOCAL_HOSTS.has(host)) return
  throw new Error(
    `The migration tests create and drop databases, and sweep every ${SCRATCH_PREFIX}_* on the server. ` +
      `POSTGRES_HOST is "${host}", which is not this machine. ` +
      `Set KUKAN_TEST_DB_ALLOW_REMOTE=1 if that is intended.`
  )
}

/**
 * Drop one, and carry on if it will not go.
 *
 * A failure here — a session FORCE cannot terminate, a backend that reconnected
 * between the scan and the drop — would otherwise reject the globalSetup, and
 * vitest then aborts the whole `*-integration` run before a single test, on
 * every run until someone drops the database by hand.
 */
async function dropQuietly(client: Client, name: string): Promise<void> {
  if (!NAME.test(name)) return // never interpolate a name this file did not shape
  try {
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  } catch (err) {
    process.stdout.write(`Could not drop ${name}: ${(err as Error).message}\n`)
  }
}

/** Drop what finished runs left behind, asking each run's lock whether it is over. */
async function dropOrphans(client: Client): Promise<void> {
  const { rows } = await client.query<{ datname: string }>(
    'SELECT datname FROM pg_database WHERE datname ~ $1',
    [NAME_SQL]
  )
  for (const { datname } of rows) {
    const token = NAME.exec(datname)?.[1]
    if (!token) continue
    const key = lockKey(token)
    const held = await client.query<{ got: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS got',
      [LOCK_NAMESPACE, key]
    )
    if (!held.rows[0].got) continue // that run is still going
    try {
      await dropQuietly(client, datname)
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, key])
    }
  }
}

/** Drop this run's own databases, and only those. */
async function dropRun(prefix: string): Promise<void> {
  const client = new Client({ connectionString: scratchUrl('postgres') })
  await client.connect()
  try {
    const { rows } = await client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname ~ $1',
      [`^${prefix}_[0-9]+$`]
    )
    for (const { datname } of rows) await dropQuietly(client, datname)
  } finally {
    await client.end()
  }
}

/** Returned rather than awaited into nothing: vitest calls it when the run ends. */
export async function setup(project: TestProject) {
  refuseRemoteServer()
  const token = `${Date.now().toString(36)}${randomBytes(6).toString('hex')}`
  const prefix = `${SCRATCH_PREFIX}_${token}`

  const admin = new Client({ connectionString: scratchUrl('postgres') })
  await admin.connect()
  try {
    await dropOrphans(admin)
  } finally {
    await admin.end()
  }

  // Held for the life of the run, on a connection of its own: this is what
  // tells another run's sweep that the database is in use. It goes when the
  // process does, however the process goes.
  const alive = new Client({ connectionString: scratchUrl('postgres') })
  await alive.connect()
  await alive.query('SELECT pg_advisory_lock($1, $2)', [LOCK_NAMESPACE, lockKey(token)])

  project.provide('migrateScratchPrefix', prefix)
  return async () => {
    try {
      await dropRun(prefix)
    } finally {
      await alive.end()
    }
  }
}
