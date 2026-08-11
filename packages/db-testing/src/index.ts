/**
 * Creating and clearing up the databases an integration suite runs against.
 *
 * Its own package, and one nothing is built from: this drops databases, and
 * @kukan/db carried it as far as the worker's production node_modules, where
 * `pnpm deploy --prod` left both the compiled copy and the source. A vitest
 * devDependency cannot go there. @kukan/db still owns the migrations, and hands
 * over their folder — the one thing about them that is a path.
 *
 * One database per process, not per suite. Every test truncates between cases,
 * so two files on one database clear each other's rows mid-test — which is why
 * the integration projects ran serially and dominated the test run.
 *
 * Per process rather than per pool slot, which is what this used to key on:
 * `VITEST_POOL_ID` is not unique among the processes running at any one moment.
 * Measured by tagging each pool's connections with its pid and asking
 * `pg_stat_activity` at every truncate — over two full runs, 197 truncates
 * found another live process on the same slot database, one of them active
 * while the other cleared the tables. It surfaced as unrelated suites failing
 * on rows they had just written, in whichever file lost the race.
 *
 * Names carry the run that made them, so two people — or two agents — on one
 * machine do not clear each other's rows. The pid alone would not do it: pids
 * are reused, and two runs would collide the moment one did.
 */
import { randomBytes } from 'node:crypto'
import { Client, Pool, type PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { databaseUrl } from '@kukan/shared'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MIGRATIONS_FOLDER as MIGRATIONS } from '@kukan/db'

/** Setup runs before any reporter, so this is the only channel it has. */
const report = (message: string) => process.stdout.write(`${message}\n`)

/**
 * Where the repo says Postgres is, rather than a reading of `DATABASE_URL` only
 * this file had. `POSTGRES_*` is the one knob, and pointing the project at a
 * different server used to leave the tests on localhost without saying so.
 */
const SERVER_URL = databaseUrl()

/** Where a Postgres that can be treated as disposable lives. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * Refuse to work on a server that is not this machine's.
 *
 * This file creates and drops databases, and sweeps every `kukan_test_*` it
 * finds. That was survivable while it read a `DATABASE_URL` nobody sets: you had
 * to aim it deliberately. Now that it follows `POSTGRES_*` like the rest of the
 * repo — which is the point — pointing the project at a shared Postgres aims it
 * there too, and the first `pnpm test:integration` would be the notice.
 *
 * An env var rather than no escape at all: a suite run inside a compose network
 * reaches Postgres by service name, and is as disposable as any container.
 *
 * A guardrail, not a proof. The name is all this can go on, so a shared server
 * forwarded to a local port reads as local and is let through.
 *
 * On each function that reaches the server rather than once on the way in.
 * `createTestDatabase` runs in the worker processes, where the setup that would
 * have vouched for the server never ran — the guard held there only because a
 * refusal in the main process stops the run before a worker starts, which is an
 * ordering, not an invariant, and not one a new caller inherits.
 */
function refuseRemoteServer(): void {
  if (process.env.KUKAN_TEST_DB_ALLOW_REMOTE === '1') return
  // `hostname` brackets an IPv6 literal; the set holds bare addresses.
  const host = new URL(SERVER_URL).hostname.replace(/^\[|\]$/g, '')
  if (LOCAL_HOSTS.has(host)) return
  throw new Error(
    `The integration suites create and drop databases, and sweep every kukan_test_* on the server. ` +
      `POSTGRES_HOST is "${host}", which is not this machine. ` +
      `Set KUKAN_TEST_DB_ALLOW_REMOTE=1 if that is intended.`
  )
}

/** Migrated once; every process's database is copied from it. */
const TEMPLATE = 'kukan_test_template'

/**
 * `kukan_test_<suite>_<token>_<pid>`, where the token is 8 base-36 characters
 * of creation time and 12 hex of randomness — a fixed twenty.
 *
 * Fixed-width on purpose. An earlier pattern allowed any length, and
 * `kukan_test_api_temp_0_1` matched it: the sweep read `temp` as a base-36
 * timestamp, got 1970, and dropped the database as ancient. The suite segment
 * takes digits, because `api2` would otherwise produce databases no sweep could
 * ever match — a leak with no warning.
 */
const NAME = /^kukan_test_[a-z0-9]+_([0-9a-z]{8}[0-9a-f]{12})_\d+$/
const NAME_SQL = '^kukan_test_[a-z0-9]+_[0-9a-z]{8}[0-9a-f]{12}_[0-9]+$'

/** Advisory locks are (int, int); this half says the other half is one of ours. */
const LOCK_NAMESPACE = 4771

/** The template migration's lock, distinct from any run's. */
const TEMPLATE_LOCK = 1

/**
 * A run's token, as an advisory-lock key.
 *
 * Two live runs whose tokens collide would each read the other as alive and
 * leave its databases alone — the safe direction, and the reason a plain 32-bit
 * hash is enough.
 */
function lockKey(token: string): number {
  let hash = 0
  for (let i = 0; i < token.length; i++) hash = (Math.imul(hash, 31) + token.charCodeAt(i)) | 0
  // Never the template's key, whatever the hash says.
  return hash === TEMPLATE_LOCK ? TEMPLATE_LOCK + 1 : hash
}

/**
 * The server from the environment, with `name` as the database.
 *
 * One knob points every suite at a Postgres, and the name — which is what keeps
 * two files off each other's rows — always applies.
 */
export function testDatabaseUrl(name: string): string {
  const url = new URL(SERVER_URL)
  url.pathname = `/${name}`
  return url.toString()
}

/**
 * This process's database, from the prefix its project provided.
 *
 * A file gets a process of its own under `isolate: true`, so this is a database
 * per file — and a process that vitest reuses for a second file simply reuses
 * the database, which is safe because that is sequential.
 */
export function testDatabaseName(prefix: string): string {
  return `${prefix}_${process.pid}`
}

/**
 * Whether the template still describes the migrations on disk.
 *
 * `migrate` only moves forward, so a template built on a branch with newer
 * migrations survives a checkout backwards and hands every file a schema the
 * tests were not written against — silently, and with no way to reset it short
 * of dropping the database by hand.
 */
function templateIsAhead(applied: number): boolean {
  const journal = JSON.parse(readFileSync(resolve(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
    entries: unknown[]
  }
  return applied > journal.entries.length
}

/**
 * Bring the template up to date, under a lock so that two suites starting
 * together migrate it once rather than twice.
 *
 * Migrating rather than rebuilding: a copy costs ~20ms against ~440ms for a
 * fresh migration run, and every file pays the copy.
 */
async function ensureTemplate(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_lock($1, $2)', [LOCK_NAMESPACE, TEMPLATE_LOCK])
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEMPLATE])
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE ${TEMPLATE}`)
      report(`Created template database: ${TEMPLATE}`)
    }

    let pool = new Pool({ connectionString: testDatabaseUrl(TEMPLATE) })
    try {
      const applied = await pool
        .query<{ count: string }>('SELECT count(*) FROM drizzle.__drizzle_migrations')
        .then((r) => Number(r.rows[0].count))
        .catch(() => 0)

      if (templateIsAhead(applied)) {
        // Nothing else can reset it: the sweep skips the template by name, and
        // migrating forward cannot undo a migration this branch does not have.
        await pool.end()
        await client.query(`DROP DATABASE ${TEMPLATE} WITH (FORCE)`)
        await client.query(`CREATE DATABASE ${TEMPLATE}`)
        report(`Rebuilt template database: it was ahead of ${MIGRATIONS}`)
        pool = new Pool({ connectionString: testDatabaseUrl(TEMPLATE) })
      }

      // Ahead of the migrations, which assume it.
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')
      await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS })
    } finally {
      // Copying from a template needs every other session off it.
      await pool.end()
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, TEMPLATE_LOCK])
  }
}

/**
 * Drop what runs that are over left behind.
 *
 * A run holds an advisory lock on its own token for as long as its process
 * lives, so "can I take that lock?" is proof the run is gone. Asking Postgres
 * who is *connected* is not: a live run's pools are lazy and time out their
 * idle connections, so most of a database's life has nobody on it. Measured, a
 * live run's databases showed zero connections 82% of the time — a sweep that
 * trusted that reading deleted a running suite's data, which is why this asks
 * a different question.
 *
 * It also removes the need to wait an interval before collecting: a run killed
 * with Ctrl-C — which vitest does not give its teardown a chance to handle —
 * drops its connection, and with it the lock, so the next run reclaims its
 * databases at once.
 */
async function dropOrphans(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ datname: string }>(
    'SELECT datname FROM pg_database WHERE datname ~ $1',
    [NAME_SQL]
  )

  const byRun = new Map<string, string[]>()
  for (const { datname } of rows) {
    const token = NAME.exec(datname)?.[1]
    if (!token) continue
    byRun.set(token, [...(byRun.get(token) ?? []), datname])
  }

  let dropped = 0
  for (const [token, names] of byRun) {
    const key = lockKey(token)
    const held = await client.query<{ got: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS got',
      [LOCK_NAMESPACE, key]
    )
    if (!held.rows[0].got) continue // that run is still going

    try {
      for (const name of names) dropped += await dropQuietly(client, name)
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, key])
    }
  }
  if (dropped > 0) report(`Dropped ${dropped} database(s) from finished runs`)
}

/**
 * Drop one, and carry on if it will not go.
 *
 * A database that gains a connection between the scan and the drop raises
 * 55006, and unhandled that aborts the whole run before a single test — a
 * failure worth nobody's time when the alternative is leaving one database for
 * the next sweep.
 */
async function dropQuietly(client: PoolClient, name: string): Promise<number> {
  if (!NAME.test(name)) return 0 // never interpolate a name this file did not shape
  try {
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    return 1
  } catch {
    return 0
  }
}

/**
 * Drop every test database no run is holding, including the ones the old
 * one-per-suite scheme left behind.
 *
 * Named separately from the sweep because those are different jobs: the sweep
 * runs on the way in and only collects what its own naming produced, while this
 * is the front door for "clear this machine up" and takes the strays too.
 */
export async function cleanTestDatabases(): Promise<{ dropped: string[]; kept: string[] }> {
  refuseRemoteServer()
  const admin = new Pool({ connectionString: SERVER_URL })
  const client = await admin.connect()
  const dropped: string[] = []
  const kept: string[] = []
  try {
    const { rows } = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname ~ $1 OR datname IN ('kukan_test', 'kukan_worker_test', $2)`,
      [NAME_SQL, TEMPLATE]
    )
    for (const { datname } of rows) {
      const token = NAME.exec(datname)?.[1]
      if (token) {
        const held = await client.query<{ got: boolean }>(
          'SELECT pg_try_advisory_lock($1, $2) AS got',
          [LOCK_NAMESPACE, lockKey(token)]
        )
        if (!held.rows[0].got) {
          kept.push(datname)
          continue
        }
        await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, lockKey(token)])
      }
      // The strays and the template have no run to ask about; a connection is
      // the only signal left, and here it is the right one — nothing holds one
      // of these except a person with a psql window open.
      const busy = await client.query('SELECT 1 FROM pg_stat_activity WHERE datname = $1', [
        datname,
      ])
      if (busy.rowCount !== 0) {
        kept.push(datname)
        continue
      }
      try {
        await client.query(`DROP DATABASE IF EXISTS "${datname}"`)
        dropped.push(datname)
      } catch {
        kept.push(datname)
      }
    }
  } finally {
    client.release()
    await admin.end()
  }
  return { dropped, kept }
}

/** What a suite's `globalSetup` hands back. */
export interface TestDatabases {
  /** The name every process builds its own database name from. */
  prefix: string
  /** Vitest calls this when the run ends — though not when it is interrupted. */
  teardown: () => Promise<void>
}

/**
 * Prepare `suite` for this run.
 *
 * The databases themselves are made on demand: how many processes vitest opens
 * is its decision and it varies with the file count, so a fixed number here
 * would either waste them or run out.
 */
export async function setupTestDatabase(suite: string): Promise<TestDatabases> {
  refuseRemoteServer()
  const token = `${Date.now().toString(36)}${randomBytes(6).toString('hex')}`
  const prefix = `kukan_test_${suite}_${token}`

  const admin = new Pool({ connectionString: SERVER_URL })
  const client = await admin.connect()
  try {
    await dropOrphans(client)
    await ensureTemplate(client)
  } finally {
    client.release()
    await admin.end()
  }

  // Held for the life of the run, on a connection of its own: this is what
  // tells another run's sweep that these databases are in use. It goes when the
  // process does, however the process goes.
  const alive = new Client({ connectionString: SERVER_URL })
  await alive.connect()
  await alive.query('SELECT pg_advisory_lock($1, $2)', [LOCK_NAMESPACE, lockKey(token)])

  return {
    prefix,
    teardown: async () => {
      try {
        await dropRun(prefix)
      } finally {
        await alive.end()
      }
    },
  }
}

/** Drop every database this run made. Vitest calls this on failure too. */
async function dropRun(prefix: string): Promise<void> {
  const admin = new Pool({ connectionString: SERVER_URL })
  const client = await admin.connect()
  try {
    const { rows } = await client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname ~ $1',
      [`^${prefix}_[0-9]+$`]
    )
    for (const { datname } of rows) await dropQuietly(client, datname)
  } finally {
    client.release()
    await admin.end()
  }
}

/**
 * This process's database, copied from the template if it is not there yet.
 *
 * No retry: `CREATE DATABASE … TEMPLATE` does not fail while another session is
 * on the source — Postgres waits five seconds for it to leave — so a failure
 * here is one that waiting will not fix. An earlier version looped twenty
 * times, which under vitest's ten-second hook timeout meant the developer saw
 * `Hook timed out` and never the reason.
 */
export async function createTestDatabase(name: string): Promise<void> {
  refuseRemoteServer()
  const admin = new Pool({ connectionString: SERVER_URL })
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`)
  } catch (err) {
    // Already there: this process's second file, or — before the name carried
    // the pid — a file that started at the same moment and won the copy.
    //
    // Asked of the server rather than read off the error code, because the
    // race is lost in more than one place — `42P04` from the existence check
    // CREATE DATABASE does up front, `23505` on the catalog insert when a copy
    // started after that check and won — and a code this does not recognize
    // fails the whole file for no reason it can act on. The state is the
    // question; the code is trivia.
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    if (existing.rowCount && existing.rowCount > 0) return
    throw new Error(
      `Could not copy ${TEMPLATE} into ${name} (pid ${process.pid}). ` +
        `Anything connected to ${TEMPLATE} — a psql session, a database GUI — blocks this.`,
      { cause: err }
    )
  } finally {
    await admin.end()
  }
}
