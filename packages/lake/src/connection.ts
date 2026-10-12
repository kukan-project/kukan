/**
 * DuckLake connection (ADR-043 layer 2 / Phase ii).
 *
 * Opens an in-memory DuckDB session, loads the required extensions and points it
 * at the S3/MinIO bucket. That setup is instance-scoped, so it is done once per
 * process and every session after the first is a connection on it. A session
 * names the catalog it works on by alias (`LakeSession.catalog`); the shared
 * one, backed by PostgreSQL, is attached as `lake` on the first session that
 * asks for it. All DuckLake access is
 * confined to this module (ADR-005): the worker writes through it, the API
 * reads through it, nothing else touches DuckLake directly.
 *
 * Validated against dev PostgreSQL + MinIO in the Phase ii spike: extension
 * load, ATTACH, ingest, time travel, and `table_changes` all work.
 */
import type { DiffRow } from '@kukan/shared'
import type { LakeConfig } from './config'
import {
  LAKE_DATA_PREFIX,
  LAKE_METADATA_SCHEMA,
  lakeStorageUrl,
  loadDuckdbExtensions,
  s3SecretBody,
} from './config'
import { openDuckdb } from './duckdb'
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

/** The alias the shared catalog is attached as. */
const SHARED_CATALOG = 'lake'

export interface LakeSessionOptions {
  /**
   * Run the work once more, on a rebuilt instance, when the session failed
   * because its instance was lost ({@link isInstanceLost}). The work then has
   * to be safe to run twice, **and its result is the second run's alone**:
   * whatever the first run did before the loss is neither undone nor
   * reported. The work is told which attempt it is on, so it can at least say
   * so. Right for a sweep whose result is a count for the log; wrong for
   * anything that acts on the value.
   */
  rerunIfLost?: boolean
}

/** The DuckDB instance type, without importing the module eagerly. */
type DuckDBInstance = Awaited<
  ReturnType<(typeof import('@duckdb/node-api'))['DuckDBInstance']['create']>
>

/**
 * How long a session waits for a catalog connection before failing: as long as
 * another can hold one. An ingest holds its own through the statement that
 * writes the Parquet — minutes for a large file — and the default 30 s would
 * fail the sweep waiting beside it.
 */
const LAKE_CATALOG_WAIT_TIMEOUT_MS = 10 * 60_000

/**
 * Prepared instances, keyed by what makes them differ.
 *
 * Everything setup does is instance-scoped — loaded extensions, the S3 secret,
 * the attached catalog, and `memory_limit`/`threads`, which DuckDB treats as
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
 * Errors a session threw *because* its instance was lost — what
 * {@link withLakeSession} reruns on. Not {@link isInstanceLost} over any error
 * out of the work, whose own failures (a Postgres transaction dropping its
 * connection, say) can read the same and mean nothing about the instance.
 */
const lostWith = new WeakSet<object>()
const markLost = (err: unknown) => {
  if (typeof err === 'object' && err !== null) lostWith.add(err)
}
const wasLost = (err: unknown) => typeof err === 'object' && err !== null && lostWith.has(err)

/**
 * Errors that mean the instance itself is finished — the catalog's libpq
 * connection went away, or the S3 secret's temporary credentials expired —
 * rather than the statement being wrong. The cached instance is dropped so the
 * next caller rebuilds; the current call still fails, and its caller retries
 * (the queue's retry for ingest, the user for a diff, or {@link withLakeSession}
 * itself where asked).
 *
 * A connect refused because the instance is closed is the same thing seen
 * from the next caller: one session's loss closed it, and another had already
 * taken the instance out of the cache before that.
 *
 * Expired credentials are the backstop for `REFRESH auto` below: the refresh
 * only fires on the error codes httpfs recognizes, and a task-role credential
 * that lapsed mid-statement can still surface as a plain ExpiredToken. A
 * rebuild resolves the chain afresh either way.
 */
function isInstanceLost(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  // Waited out the catalog pool: the instance is busy, not gone, and closing
  // it would take the sessions holding the pool down with it
  if (/connection pool timeout/i.test(message)) return false
  return /connection|server closed|terminating|SSL|socket|ExpiredToken|token has expired|instance closed/i.test(
    message
  )
}

/**
 * Turn off DuckLake's data inlining, which keeps small tables' rows in the
 * catalog instead of Parquet (ADR-043 §6-1).
 *
 * Inlined rows are never reclaimed: once every snapshot that could observe one
 * is expired, it is unreachable through DuckLake yet still sits in PostgreSQL,
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
  // Its own place to spill, before the ATTACH that can start writing there
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

    await loadDuckdbExtensions(conn, ['httpfs', 'aws', 'postgres', 'sqlite', 'ducklake'])

    // S3 credentials, in the one shape both this and the OData feed use
    // (`s3SecretBody` — where the REFRESH story is written down).
    await conn.run(`CREATE OR REPLACE SECRET lake_s3 (${s3SecretBody(config)})`)

    // Read by the shared catalog's ATTACH, so set before any. Past the cap a
    // transaction waits for a connection rather than opening one more, as it
    // would by default (see LakeLimits.catalogConnections)
    await conn.run(`SET pg_pool_max_connections = ${Math.trunc(config.limits.catalogConnections)}`)
    await conn.run(`SET pg_pool_acquire_mode = 'wait'`)
    await conn.run(`SET pg_pool_wait_timeout_millis = ${LAKE_CATALOG_WAIT_TIMEOUT_MS}`)
    return instance
  } catch (err) {
    // Setup failed partway (extension load, S3 secret). The instance
    // would otherwise become unreachable while holding its buffer manager,
    // worker threads, and whatever the ATTACH opened. No session was ever
    // opened on it, so `retire` takes the directory with it here.
    retire(instance)
    throw err
  } finally {
    conn.disconnectSync()
  }
}

/**
 * Instances the shared catalog is attached to, by the attach in flight or done.
 *
 * Attached on the first session that names it rather than when the instance is
 * prepared: a process that only reads the bucket, or only per-resource catalogs
 * (ADR-067), then never opens a connection to PostgreSQL. ATTACH binds the
 * instance, not the connection, so once per instance.
 */
const sharedCatalogs = new WeakMap<DuckDBInstance, Promise<void>>()

function attachSharedCatalog(instance: DuckDBInstance, config: LakeConfig): Promise<void> {
  let attaching = sharedCatalogs.get(instance)
  if (!attaching) {
    attaching = (async () => {
      const conn = await instance.connect()
      let attached = false
      try {
        await conn.run(
          `ATTACH ${sqlLiteral(`ducklake:postgres:${config.pgConnString}`)} AS ${SHARED_CATALOG} ` +
            `(DATA_PATH ${sqlLiteral(lakeStorageUrl(config, LAKE_DATA_PREFIX))}, ` +
            `METADATA_SCHEMA ${sqlLiteral(LAKE_METADATA_SCHEMA)})`
        )
        attached = true
        await disableDataInlining(
          {
            run: async (sql) => void (await conn.run(sql)),
            rows: async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson() as LakeRow[],
          },
          SHARED_CATALOG
        )
      } catch (err) {
        // Undone with the record below, or the next session's ATTACH finds
        // the alias taken and fails for as long as the instance lives.
        if (attached) await conn.run(`DETACH ${SHARED_CATALOG}`).catch(() => {})
        throw err
      } finally {
        conn.disconnectSync()
      }
    })()
    sharedCatalogs.set(instance, attaching)
    // A failed attach must not be cached, or the instance never gets one.
    attaching.catch(() => sharedCatalogs.delete(instance))
  }
  return attaching
}

/**
 * Open a session on the process's prepared instance, with no catalog.
 *
 * The caller owns it and must `close()` when done; that disconnects, and leaves
 * the instance for the next operation.
 */
export function openBucketSession(config: LakeConfig): Promise<BucketSession> {
  return openSession(config, () => Promise.resolve())
}

/**
 * Open a session on the shared DuckLake catalog, attached as `lake`.
 *
 * The caller owns it and must `close()` when done; that disconnects, and leaves
 * the instance for the next operation.
 */
export async function openLakeSession(config: LakeConfig): Promise<LakeSession> {
  const session = await openSession(config, (instance) => attachSharedCatalog(instance, config))
  return { ...session, catalog: SHARED_CATALOG }
}

async function openSession(
  config: LakeConfig,
  ready: (instance: DuckDBInstance) => Promise<void>
): Promise<BucketSession> {
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
      markLost(err)
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
    await ready(instance)
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
      // JSON variant serializes BIGINT etc. to JSON-safe values.
      return reader.getRowObjectsJson() as LakeRow[]
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
 * Close every prepared instance. For shutdown: each holds worker threads and
 * the libpq connection its catalog ATTACH opened, neither of which a process
 * should still be holding while it drains.
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
 * session prepares an instance afresh — the extension loads and the ATTACH, a
 * second or so.
 *
 * A session that takes the instance in the same turn as this closes it finds it
 * closed, which reads as a lost instance (`isInstanceLost`): its caller reruns
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
 * Open a session, run `fn`, and close it whatever happens. A leaked session
 * holds a connection on the shared instance, so every caller needs this — use
 * it unless you need the session object itself (the diff races setup against a
 * deadline).
 *
 * With `rerunIfLost`, a session that failed because its instance was lost is
 * followed by one more run on a rebuilt instance: a task-role credential
 * lapsing between one call and the next is the ordinary case, and the
 * caller's own retry would be a rerun of `fn` anyway — this saves the wait for
 * it. A second loss in a row is reported, not retried again.
 */
export function withLakeSession<T>(
  config: LakeConfig,
  fn: (session: LakeSession, attempt: 1 | 2) => Promise<T>,
  options: LakeSessionOptions = {}
): Promise<T> {
  return withSession(() => openLakeSession(config), fn, options)
}

/** {@link withLakeSession} for a session with no catalog ({@link openBucketSession}). */
export function withBucketSession<T>(
  config: LakeConfig,
  fn: (session: BucketSession, attempt: 1 | 2) => Promise<T>,
  options: LakeSessionOptions = {}
): Promise<T> {
  return withSession(() => openBucketSession(config), fn, options)
}

async function withSession<S extends BucketSession, T>(
  open: () => Promise<S>,
  fn: (session: S, attempt: 1 | 2) => Promise<T>,
  { rerunIfLost = false }: LakeSessionOptions
): Promise<T> {
  try {
    return await inSession(open, (session) => fn(session, 1))
  } catch (err) {
    if (!rerunIfLost || !wasLost(err)) throw err
    return inSession(open, (session) => fn(session, 2))
  }
}

async function inSession<S extends BucketSession, T>(
  open: () => Promise<S>,
  fn: (session: S) => Promise<T>
): Promise<T> {
  const session = await open()
  try {
    return await fn(session)
  } finally {
    await session.close().catch(() => {})
  }
}
