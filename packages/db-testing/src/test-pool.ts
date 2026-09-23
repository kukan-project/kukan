/**
 * The pool an integration harness queries through, and the truncate that clears
 * it between tests.
 *
 * A truncate needs ACCESS EXCLUSIVE on every table it names. A query the
 * previous test left running holds ACCESS SHARE on the tables it reads, and a
 * read of several tables takes those locks one at a time in its own order — so
 * the truncate and the leftover can each end up holding what the other is
 * waiting for. Postgres then kills one of them: in CI it killed the truncate,
 * and the file failed in its `beforeEach` with `deadlock detected`.
 *
 * A test leaves a query running whenever a handler answers before all the work
 * it started has finished. `Promise.all` settles on the first rejection and
 * leaves its siblings running, so a visibility check that throws sends the 404
 * while the query beside it is still on the wire. That costs nothing in
 * production — pg returns the connection when the query ends, and nothing
 * truncates — so the isolation this restores is the whole point.
 *
 * Here rather than in each harness because the pool is where the fix lives:
 * both the ceiling below and the truncate are decisions about connections, and
 * a harness that made its own would have to get both right by copying them.
 */
import { Pool, type PoolClient } from 'pg'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * Two per process, not five.
 *
 * Parallel files multiply this by however many processes vitest opens — 23 on a
 * 24-core box — and a second run on the same machine doubles it again. At five
 * that was 115 potential connections a run against a server offering 97:
 * measured, two concurrent runs hit the ceiling and both failed with
 * `sorry, too many clients already`, reported as unrelated assertion failures.
 *
 * Not slack that could be trimmed further: a file's tests run one at a time,
 * but `truncateTables` takes every connection there is, and a suite whose
 * handlers query in parallel needs more than one to make progress. Measured,
 * the second connection costs 6ms once per process.
 */
const POOL_MAX = 2

/**
 * Long enough for any query these suites run, short enough to land before
 * vitest's 10s hook timeout — which is where a wait for connections would
 * otherwise surface, with nothing to say about the cause.
 */
const ACQUIRE_TIMEOUT_MS = 5_000

/**
 * How many times to clear up after a leftover before calling it someone else's
 * problem.
 *
 * A leftover of `await a; await b` gets one attempt per statement, so a handful
 * covers the sequences these suites run. More than that and the work is not
 * finishing — a background loop, or a query whose own statements keep arriving —
 * which no number of truncates would settle.
 */
const TRUNCATE_ATTEMPTS = 5

/**
 * One wait for a whole call, however many attempts it takes.
 *
 * A deadline per attempt would be {@link TRUNCATE_ATTEMPTS} times
 * {@link ACQUIRE_TIMEOUT_MS} — five leftover statements of four seconds each and
 * the hook times out at ten, which is the thing that deadline exists to get in
 * front of. `totalMs` is kept for the message: what a reader needs to know is
 * how long was allowed, not how much of it the last attempt had left.
 */
export function budget(totalMs: number) {
  const until = Date.now() + totalMs
  return { totalMs, remainingMs: () => Math.max(until - Date.now(), 0) }
}

type Budget = ReturnType<typeof budget>

/** A harness's pool, at the ceiling every harness shares. */
export function createTestPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: POOL_MAX })
}

/**
 * Truncate `tables` — FK-safe with CASCADE — and leave them empty.
 *
 * Holding the pool keeps a leftover query out of the truncate's locks, but not
 * out of the tables: a leftover `await read; await write` can have its read
 * finish before the truncate and its write queued behind it, and that write
 * lands on tables the truncate has just emptied. So an attempt that finds
 * anything queued does not count — the connections go back so that work can
 * finish, and the truncate runs again once it has.
 *
 * That check lands where it needs to. Measured on the sequence above: the
 * leftover issues its write the moment its read gives the connection back,
 * which is the moment the truncate has been waiting for — so the write is
 * already queued before the truncate runs, and the attempt is abandoned before
 * it empties anything. The check after the statement is for the narrower case of
 * work that arrives while it runs.
 *
 * What this cannot see is a leftover that is between statements with none
 * queued — waiting on something other than the database, say. Nothing at the
 * pool distinguishes that from work that has finished.
 *
 * Quoted names, so a table named after a reserved word (`group`) needs nothing
 * of the caller. Every name in these lists is lower case, which is what quoting
 * keeps.
 */
export async function truncateTables(pool: Pool, tables: string[]): Promise<void> {
  const names = tables.map((table) => `"${table}"`).join(', ')
  const statement = `TRUNCATE TABLE ${names} CASCADE`
  const waiting = budget(ACQUIRE_TIMEOUT_MS)

  for (let attempt = 1; attempt <= TRUNCATE_ATTEMPTS; attempt++) {
    if (await runExclusively(pool, statement, waiting)) return
  }
  throw new Error(
    `Truncated ${TRUNCATE_ATTEMPTS} times and a query this harness did not start was queued ` +
      `every time. A previous test's work is still going, or something queries in a loop; ` +
      `either way the tables cannot be left empty while it runs.`
  )
}

/**
 * Run `statement` with every one of the pool's connections checked out.
 *
 * Holding the pool rather than waiting for it to go quiet, because a leftover
 * *sequence* of queries can be between two of them when we look. With every
 * connection taken, a query that starts late waits for one instead of racing
 * the statement for locks.
 *
 * False when the pool was not ours alone — something was queued before the
 * statement (in which case it did not run) or during it (in which case it did,
 * and the queued work is about to land on the result). `waitingCount` is only
 * other people's requests by this point: ours have all been granted.
 *
 * Not exported from the package: what a harness needs is the truncate above.
 * A caller who could hold the pool for arbitrary work would be able to
 * serialize a whole file behind the deadline below, and would have to decide
 * what a `false` means. This package's own test imports it directly, which is
 * the only thing a statement of its own choosing is wanted for.
 *
 * `waiting` is the time left for the connections, shared with whatever other
 * attempts the caller makes; only that test passes one of its own.
 */
export async function runExclusively(
  pool: Pool,
  statement: string,
  waiting: Budget = budget(ACQUIRE_TIMEOUT_MS)
): Promise<boolean> {
  const clients = await acquireAll(pool, waiting)
  try {
    if (pool.waitingCount > 0) return false
    await clients[0].query(statement)
    return pool.waitingCount === 0
  } finally {
    // Releasing is also what lets a queued leftover finish: the next attempt's
    // requests queue behind the leftover's, so acquiring again waits for it.
    for (const client of clients) client.release()
  }
}

/**
 * Check out every connection the pool has, or none.
 *
 * Asking for all of them is also the wait: the pool cannot hand over one a
 * query is using, so there is nothing to poll for first.
 *
 * The deadline is for what waiting cannot fix — a client checked out and never
 * released, or a transaction left open. `pool.connect()` has no timeout of its
 * own, so that would hang until vitest gave up on the hook, with nothing to say
 * about the cause. Whatever we did get goes back, along with whatever a request
 * delivers afterwards, so one stuck test does not leave the rest of the file
 * without connections to run on.
 */
async function acquireAll(pool: Pool, waiting: Budget): Promise<PoolClient[]> {
  let abandoned = false
  const held: PoolClient[] = []
  const requests = Array.from({ length: pool.options.max }, () =>
    pool.connect().then((client) => {
      if (abandoned) client.release()
      else held.push(client)
      return client
    })
  )

  const abort = new AbortController()
  try {
    return await Promise.race([
      Promise.all(requests),
      sleep(waiting.remainingMs(), undefined, { signal: abort.signal }).then<never>(() => {
        throw new Error(
          `Waited ${waiting.totalMs}ms for the test pool's ${pool.options.max} connections and ` +
            `got ${held.length}. A test left a transaction open, a client it never released, or ` +
            `work that is still running.`
        )
      }),
    ])
  } catch (error) {
    // Either the deadline or a `connect()` of its own — `sorry, too many clients
    // already` is the one this repo has hit. Without this, its siblings would
    // stay checked out for the rest of the file.
    abandoned = true
    for (const client of held.splice(0)) client.release()
    throw error
  } finally {
    abort.abort()
  }
}
