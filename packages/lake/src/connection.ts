/**
 * DuckLake connection (ADR-043 layer 2 / Phase ii).
 *
 * Opens an in-memory DuckDB session, loads the required extensions and points it
 * at the S3/MinIO bucket. That setup is instance-scoped, so it is done once per
 * process and every session after the first is a connection on it. A session
 * names the catalog it works on by alias (`LakeSession.catalog`): a resource's
 * own, which `catalog.ts` attaches (ADR-067). All DuckLake access is confined
 * to this package (ADR-005): the worker writes through it, the API reads
 * through it, nothing else touches DuckLake directly.
 */
import type { DiffRow } from '@kukan/shared'
import type { LakeConfig } from './config'
import { loadDuckdbExtensions, s3SecretBody } from './config'
import { openDuckdb } from './duckdb'
import { rowObjectsJson } from './json-rows'
import { createSpillRegistry } from './spill'
import { assertSafeIdentifier, sqlLiteral } from './sql'

/** A row read back from DuckDB, by column name. The diff samples reach the
 *  client as they are read, so it is the wire's `DiffRow` and not a copy. */
export type LakeRow = DiffRow

/**
 * A DuckDB session on the lake's instance: its extensions and S3 secret, and
 * no catalog. What reads Parquet straight from the bucket needs (the key
 * check), and what a session naming a catalog extends.
 */
export interface BucketSession {
  /** Execute a statement with no result set. */
  run(sql: string): Promise<void>
  /** Execute a query and return all rows as objects. */
  rows(sql: string): Promise<LakeRow[]>
  /** Abort the statement in flight — DuckDB has no statement_timeout. */
  interrupt(): void
  /** Release the connection; the instance stays for the next session. */
  close(): Promise<void>
}

/** A session with a DuckLake catalog attached under `catalog`. */
export interface LakeSession extends BucketSession {
  /** The alias the catalog is attached as, which every statement on it names. */
  readonly catalog: string
}

/** The DuckDB instance type, without importing the module eagerly. */
type DuckDBInstance = Awaited<
  ReturnType<(typeof import('@duckdb/node-api'))['DuckDBInstance']['create']>
>

/**
 * Prepared instances, keyed by what makes them differ.
 *
 * Everything setup does is instance-scoped — loaded extensions, the S3 secret,
 * and `memory_limit`/`threads`, which DuckDB treats as
 * globals. So it is paid once and every later session is an `instance.connect()`
 * on top of it. A process builds one config, bounds and all
 * ({@link LakeConfig.limits}), so it keeps one instance.
 *
 * The promise is cached, not the instance, so concurrent first callers wait on
 * one setup rather than racing to build several.
 */
const instances = new Map<string, Promise<DuckDBInstance>>()

/** Each prepared instance's spill directory, freed when nothing holds it. */
const spills = createSpillRegistry<DuckDBInstance>()

/**
 * Take an instance out of service; its directory goes with the last session.
 * Settles when the directory is actually gone, so a shutdown can wait for it.
 */
function retire(instance: DuckDBInstance): Promise<void> {
  instance.closeSync()
  return spills.retire(instance)
}

/**
 * Errors that mean the instance itself is finished — the bucket's connection
 * went away, or the S3 secret's temporary credentials expired — rather than
 * the statement being wrong. The cached instance is dropped so the next caller
 * rebuilds; the current call still fails, and its caller retries (the queue's
 * retry for ingest, the user for a diff).
 *
 * A connect refused because the instance is closed is the same thing seen
 * from the next caller: one session's loss closed it, and another had already
 * taken the instance out of the cache before that.
 *
 * Expired credentials are the backstop for `REFRESH auto` below: the refresh
 * only fires on the error codes httpfs recognizes, and a task-role credential
 * that lapsed mid-statement can still surface as a plain ExpiredToken. A
 * rebuild resolves the chain afresh either way.
 *
 * A DuckLake catalog whose metadata database is gone is one some earlier
 * session left half-detached. Statements naming other catalogs still run, but
 * any that lists the instance's catalogs — `duckdb_tables()`, which the
 * ingest's table check reads — fails on it until the instance goes. Seen after
 * SQLite catalogs failed with `database is locked`, by a path not reproduced;
 * whichever session meets it first takes the instance out, and the queue's
 * retry runs on a fresh one.
 */
function isInstanceLost(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return (
    /connection|socket|ExpiredToken|token has expired|instance closed/i.test(message) ||
    /Catalog "__ducklake_metadata_\w+" does not exist/.test(message)
  )
}

/**
 * Turn off DuckLake's data inlining, which keeps small tables' rows in the
 * catalog instead of Parquet (ADR-043 §6-1).
 *
 * Inlined rows are never reclaimed: once every snapshot that could observe one
 * is expired, it is unreachable through DuckLake yet still sits in the catalog,
 * and neither `expire_snapshots` nor `cleanup_old_files` removes it. With
 * inlining off the rows are in Parquet, where reclamation can at least reach
 * them — under ii-a's whole-table writes it frees a version's files whole, and
 * under ii-b it frees whatever the retained set stops holding (spec §9).
 *
 * **Not a guarantee that a purge erases anything.** What makes a purged version
 * unobtainable is nulling its `ducklake_snapshot_id`; this only keeps capacity
 * reclaimable at all, which inlined rows are not.
 *
 * Stored on the catalog rather than passed to ATTACH, which would only bind
 * this session: the setting must not depend on who opened the connection.
 * Read first so the steady state costs no catalog write.
 */
export async function disableDataInlining(
  session: Pick<BucketSession, 'run' | 'rows'>,
  catalog: string
): Promise<void> {
  const [row] = await session.rows(
    `SELECT value FROM ducklake_options(${sqlLiteral(catalog)}) WHERE option_name = 'data_inlining_row_limit'`
  )
  if (row?.value === '0') return
  await session.run(
    `CALL ${assertSafeIdentifier(catalog)}.set_option('data_inlining_row_limit', 0)`
  )
}

async function prepareInstance(config: LakeConfig): Promise<DuckDBInstance> {
  // Its own place to spill, before any session that can start writing there
  // (see `useOwnTempDirectory`): a worker holds this instance alongside the
  // CSV interpretation's, and that one is documented to go out of core.
  // Removed when the last session on it closes rather than when it does
  // (see `createSpillRegistry`).
  const { instance, conn, dropTempDir } = await openDuckdb({
    memoryLimitBytes: config.limits.memoryLimitMb * 1_000_000,
    threads: config.limits.threads,
    spill: 'lake',
  })
  spills.track(instance, dropTempDir)

  try {
    // **An instance that outlives its sessions must not keep what they read.**
    // DuckDB caches the blocks of remote files in the instance's buffer pool,
    // and only memory pressure inside this same instance evicts them — closing
    // the session does not. Measured, a scan left 206 MB resident after its
    // session had closed, in a process whose other DuckDB budgets (the query
    // slot, the feed's slots) are sized as if this instance held nothing
    // between operations. The cache buys nothing here anyway: operations on the
    // lake rarely read the same files twice.
    await conn.run('SET enable_external_file_cache = false')

    await loadDuckdbExtensions(conn, ['httpfs', 'aws', 'sqlite', 'ducklake'])

    // S3 credentials, in the one shape both this and the OData feed use
    // (`s3SecretBody` — where the REFRESH story is written down).
    await conn.run(`CREATE OR REPLACE SECRET lake_s3 (${s3SecretBody(config)})`)
    return instance
  } catch (err) {
    // Setup failed partway (extension load, S3 secret). The instance
    // would otherwise become unreachable while holding its buffer manager
    // and worker threads. No session was ever
    // opened on it, so `retire` takes the directory with it here.
    retire(instance)
    throw err
  } finally {
    conn.disconnectSync()
  }
}

/**
 * Open a session on the process's prepared instance, with no catalog.
 *
 * The caller owns it and must `close()` when done; that disconnects, and leaves
 * the instance for the next operation.
 */
export async function openBucketSession(config: LakeConfig): Promise<BucketSession> {
  const key = JSON.stringify(config)
  let pending = instances.get(key)
  if (!pending) {
    pending = prepareInstance(config)
    instances.set(key, pending)
    // A failed setup must not be cached, or the process never recovers.
    pending.catch(() => instances.delete(key))
  }

  const instance = await pending

  const forget = (err: unknown) => {
    if (isInstanceLost(err)) {
      if (instances.get(key) === pending) {
        instances.delete(key)
        void pending.then(retire).catch(() => {})
      }
    }
    throw err
  }

  // **Counted before the connection is opened, not after.** `connect()` is an
  // await, and an instance can retire across it — a shutdown resolving the same
  // setup promise, or another session losing it. Counting afterwards means this
  // session registers on an entry that is already gone, its hold is a no-op, and
  // it runs with `temp_directory` pointing at a path being removed (reproduced).
  spills.open(instance)
  let conn
  try {
    conn = await instance.connect()
  } catch (err) {
    spills.close(instance)
    throw forget(err)
  }
  let closed = false

  return {
    run: async (sql) => {
      await conn.run(sql).catch(forget)
    },
    rows: async (sql) => {
      const reader = await conn.runAndReadAll(sql).catch(forget)
      return rowObjectsJson(reader)
    },
    interrupt: () => conn.interrupt(),
    close: async () => {
      // Guarded, because a caller that closes twice would otherwise let the
      // count fall below what is open and free the directory early.
      if (closed) return
      closed = true
      conn.disconnectSync()
      await spills.close(instance)
    },
  }
}

/**
 * Close every prepared instance. For shutdown: each holds worker threads, which
 * a process should not still be holding while it drains.
 */
export async function closeLakeInstances(): Promise<void> {
  const pending = [...instances.values()]
  instances.clear()
  await Promise.all(pending.map((p) => p.then(retire).catch(() => {})))
}

/**
 * Close the prepared instances no session is using, and say how many, for a
 * process that needs the memory for something else (the worker's heavy
 * process, ADR-059). The cache the external file cache setting turns off is
 * not all an instance keeps: measured in a worker loading layer 2, the process
 * stayed some 370 MB above where it sat without it between loads. The next
 * session prepares an instance afresh — the extension loads, a second or so.
 *
 * A session that takes the instance in the same turn as this closes it finds it
 * closed, which reads as a lost instance (`isInstanceLost`): its caller retries
 * it, as after any other loss.
 */
export async function releaseIdleLakeInstances(): Promise<number> {
  let released = 0
  for (const [key, pending] of [...instances]) {
    const instance = await pending.catch(() => undefined)
    if (!instance || instances.get(key) !== pending || spills.sessions(instance) > 0) continue
    instances.delete(key)
    await retire(instance)
    released++
  }
  return released
}

/**
 * Open a session, run `fn`, and close it whatever happens: a leaked session
 * holds a connection on the shared instance.
 */
export async function withBucketSession<T>(
  config: LakeConfig,
  fn: (session: BucketSession) => Promise<T>
): Promise<T> {
  const session = await openBucketSession(config)
  try {
    return await fn(session)
  } finally {
    await session.close().catch(() => {})
  }
}
