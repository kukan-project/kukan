/**
 * DuckLake connection (ADR-043 layer 2 / Phase ii).
 *
 * Opens an in-memory DuckDB session, loads the required extensions, points it at
 * the S3/MinIO bucket, and ATTACHes the DuckLake catalog (backed by PostgreSQL)
 * as `lake`. That setup is instance-scoped, so it is done once per process and
 * every session after the first is a connection on it. All DuckLake access is
 * confined to this module (ADR-005): the worker writes through it, the API
 * reads through it, nothing else touches DuckLake directly.
 *
 * Validated against dev PostgreSQL + MinIO in the Phase ii spike: extension
 * load, ATTACH, ingest, time travel, and `table_changes` all work.
 */
import type { LakeConfig } from './config'
import { LAKE_DATA_PREFIX, LAKE_METADATA_SCHEMA, lakeStorageUrl } from './config'
import { sqlLiteral } from './sql'

export interface LakeRow {
  [column: string]: unknown
}

/** A DuckDB session with the DuckLake catalog attached as `lake`. */
export interface LakeSession {
  /** Execute a statement with no result set. */
  run(sql: string): Promise<void>
  /** Execute a query and return all rows as objects. */
  rows(sql: string): Promise<LakeRow[]>
  /** Abort the statement in flight — DuckDB has no statement_timeout. */
  interrupt(): void
  /** Release the connection; the instance stays for the next session. */
  close(): Promise<void>
}

/** Resource bounds for a session. Omit on trusted background work (ingest). */
export interface LakeSessionLimits {
  memoryLimitMb: number
  threads: number
}

/** The DuckDB instance type, without importing the module eagerly. */
type DuckDBInstance = Awaited<
  ReturnType<(typeof import('@duckdb/node-api'))['DuckDBInstance']['create']>
>
type DuckDBConnection = Awaited<ReturnType<DuckDBInstance['connect']>>

/**
 * Prepared instances, keyed by what makes them differ.
 *
 * Everything setup does is instance-scoped — loaded extensions, the S3 secret,
 * the attached catalog, and `memory_limit`/`threads`, which DuckDB treats as
 * globals. So it is paid once and every later session is an `instance.connect()`
 * on top of it. A process using two distinct limit sets (the diff bounds itself
 * more tightly than ingest) keeps one instance for each.
 *
 * The promise is cached, not the instance, so concurrent first callers wait on
 * one setup rather than racing to build several.
 */
const instances = new Map<string, Promise<DuckDBInstance>>()

/**
 * Errors that mean the instance itself is finished — the catalog's libpq
 * connection went away — rather than the statement being wrong. The cached
 * instance is dropped so the next caller rebuilds; the current call still
 * fails, and its caller retries (SQS redelivery for ingest, the user for a
 * diff).
 */
function isInstanceLost(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /connection|server closed|terminating|SSL|socket/i.test(message)
}

/**
 * Turn off DuckLake's data inlining, which keeps small tables' rows in the
 * catalog instead of Parquet (ADR-043 §6-1).
 *
 * Inlined rows are never reclaimed: once every snapshot that could observe one
 * is expired, it is unreachable through DuckLake yet still sits in PostgreSQL,
 * and neither `expire_snapshots` nor `cleanup_old_files` removes it. A purge
 * could then report a legal deletion having erased nothing. With inlining off
 * each version owns its files, so expiring it frees them whole.
 *
 * Stored on the catalog rather than passed to ATTACH, which would only bind
 * this session: the guarantee must not depend on who opened the connection.
 * Read first so the steady state costs no catalog write.
 */
async function disableDataInlining(conn: DuckDBConnection): Promise<void> {
  const reader = await conn.runAndReadAll(
    `SELECT value FROM ducklake_options('lake') WHERE option_name = 'data_inlining_row_limit'`
  )
  const [row] = reader.getRowObjectsJson() as { value?: string }[]
  if (row?.value === '0') return
  await conn.run(`CALL lake.set_option('data_inlining_row_limit', 0)`)
}

async function prepareInstance(
  config: LakeConfig,
  limits: LakeSessionLimits | undefined
): Promise<DuckDBInstance> {
  const duckdb = await import('@duckdb/node-api')
  // Container images pre-install the extensions here so a closed-network
  // deployment never has to reach extensions.duckdb.org (see Dockerfile).
  const extensionDirectory = process.env.DUCKDB_EXTENSION_DIRECTORY
  const instance = await duckdb.DuckDBInstance.create(
    ':memory:',
    extensionDirectory ? { extension_directory: extensionDirectory } : undefined
  )
  const conn = await instance.connect()

  try {
    if (limits) {
      await conn.run(`SET memory_limit = '${Math.trunc(limits.memoryLimitMb)}MB'`)
      await conn.run(`SET threads = ${Math.trunc(limits.threads)}`)
    }

    // `aws` backs PROVIDER credential_chain below. Loaded explicitly rather
    // than left to autoloading, which reaches for the network — fatal on a
    // closed-network deployment even though the image ships the extension.
    for (const ext of ['httpfs', 'aws', 'postgres', 'ducklake']) {
      await conn.run(`INSTALL ${ext}`)
      await conn.run(`LOAD ${ext}`)
    }

    // S3 credentials. With an explicit endpoint (MinIO) we must force path-style
    // addressing and the ssl flag; against AWS S3 the endpoint is omitted.
    //
    // Without static keys we are on AWS with only a task role, so the secret has
    // to resolve credentials itself: DuckDB's default provider is `config`, which
    // would sign with empty keys and get a 403 from a private bucket.
    const staticKeys = config.s3AccessKey && config.s3SecretKey
    const secretParts = [
      `TYPE s3`,
      `REGION ${sqlLiteral(config.region)}`,
      ...(staticKeys
        ? [`KEY_ID ${sqlLiteral(config.s3AccessKey!)}`, `SECRET ${sqlLiteral(config.s3SecretKey!)}`]
        : [`PROVIDER credential_chain`]),
      ...(config.s3Endpoint
        ? [
            `ENDPOINT ${sqlLiteral(config.s3Endpoint)}`,
            `URL_STYLE 'path'`,
            `USE_SSL ${config.s3UseSsl}`,
          ]
        : []),
    ]
    await conn.run(`CREATE OR REPLACE SECRET lake_s3 (${secretParts.join(', ')})`)

    await conn.run(
      `ATTACH ${sqlLiteral(`ducklake:postgres:${config.pgConnString}`)} AS lake ` +
        `(DATA_PATH ${sqlLiteral(lakeStorageUrl(config, LAKE_DATA_PREFIX))}, ` +
        `METADATA_SCHEMA ${sqlLiteral(LAKE_METADATA_SCHEMA)})`
    )
    await disableDataInlining(conn)
    return instance
  } catch (err) {
    // Setup failed partway (extension load, S3 secret, ATTACH). The instance
    // would otherwise become unreachable while holding its buffer manager,
    // worker threads, and whatever the ATTACH opened.
    instance.closeSync()
    throw err
  } finally {
    conn.disconnectSync()
  }
}

/**
 * Open a DuckLake session — a connection on the process's prepared instance.
 *
 * The caller owns it and must `close()` when done; that disconnects, and leaves
 * the instance for the next operation. `limits` applies to the instance and is
 * therefore only honoured the first time a given set is asked for.
 */
export async function openLakeSession(
  config: LakeConfig,
  limits?: LakeSessionLimits
): Promise<LakeSession> {
  const key = JSON.stringify({ config, limits })
  let pending = instances.get(key)
  if (!pending) {
    pending = prepareInstance(config, limits)
    instances.set(key, pending)
    // A failed setup must not be cached, or the process never recovers.
    pending.catch(() => instances.delete(key))
  }

  const instance = await pending
  const conn = await instance.connect()

  const forget = (err: unknown) => {
    if (isInstanceLost(err) && instances.get(key) === pending) {
      instances.delete(key)
      void pending.then((i) => i.closeSync()).catch(() => {})
    }
    throw err
  }

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
    close: async () => conn.disconnectSync(),
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
  await Promise.all(pending.map((p) => p.then((i) => i.closeSync()).catch(() => {})))
}

/**
 * Open a session, run `fn`, and close it whatever happens. A leaked session
 * holds a connection on the shared instance, so every caller needs this — use
 * it unless you need the session object itself (the diff races setup against a
 * deadline).
 */
export async function withLakeSession<T>(
  config: LakeConfig,
  fn: (session: LakeSession) => Promise<T>,
  limits?: LakeSessionLimits
): Promise<T> {
  const session = await openLakeSession(config, limits)
  try {
    return await fn(session)
  } finally {
    await session.close().catch(() => {})
  }
}
