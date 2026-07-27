/**
 * DuckLake connection (ADR-043 layer 2 / Phase ii).
 *
 * Opens an in-memory DuckDB session, loads the required extensions, points it at
 * the S3/MinIO bucket, and ATTACHes the DuckLake catalog (backed by PostgreSQL)
 * as `lake`. All DuckLake access is confined to this module (ADR-005): the
 * worker writes through it, the API reads through it, nothing else touches
 * DuckLake directly.
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
  /** Close the underlying instance/connection. */
  close(): Promise<void>
}

/** Resource bounds for a session. Omit on trusted background work (ingest). */
export interface LakeSessionLimits {
  memoryLimitMb: number
  threads: number
}

/**
 * Open a DuckLake session. The caller owns it and must `close()` when done
 * (typically per ingest/diff operation, mirroring the ADR-032 query sandbox
 * which uses a fresh instance per request).
 */
export async function openLakeSession(
  config: LakeConfig,
  limits?: LakeSessionLimits
): Promise<LakeSession> {
  const duckdb = await import('@duckdb/node-api')
  // Container images pre-install the extensions here so a closed-network
  // deployment never has to reach extensions.duckdb.org (see Dockerfile).
  const extensionDirectory = process.env.DUCKDB_EXTENSION_DIRECTORY
  const instance = await duckdb.DuckDBInstance.create(
    ':memory:',
    extensionDirectory ? { extension_directory: extensionDirectory } : undefined
  )
  const conn = await instance.connect()

  const close = async (): Promise<void> => {
    conn.disconnectSync()
    instance.closeSync()
  }

  const run = async (sql: string): Promise<void> => {
    await conn.run(sql)
  }
  const rows = async (sql: string): Promise<LakeRow[]> => {
    const reader = await conn.runAndReadAll(sql)
    // JSON variant serializes BIGINT etc. to JSON-safe values.
    return reader.getRowObjectsJson() as LakeRow[]
  }

  try {
    if (limits) {
      await run(`SET memory_limit = '${Math.trunc(limits.memoryLimitMb)}MB'`)
      await run(`SET threads = ${Math.trunc(limits.threads)}`)
    }

    // `aws` backs PROVIDER credential_chain below. Loaded explicitly rather
    // than left to autoloading, which reaches for the network — fatal on a
    // closed-network deployment even though the image ships the extension.
    for (const ext of ['httpfs', 'aws', 'postgres', 'ducklake']) {
      await run(`INSTALL ${ext}`)
      await run(`LOAD ${ext}`)
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
    await run(`CREATE OR REPLACE SECRET lake_s3 (${secretParts.join(', ')})`)

    await run(
      `ATTACH ${sqlLiteral(`ducklake:postgres:${config.pgConnString}`)} AS lake ` +
        `(DATA_PATH ${sqlLiteral(lakeStorageUrl(config, LAKE_DATA_PREFIX))}, ` +
        `METADATA_SCHEMA ${sqlLiteral(LAKE_METADATA_SCHEMA)})`
    )
  } catch (err) {
    // Setup failed partway (extension load, S3 secret, ATTACH). The instance and
    // connection already exist and would otherwise become unreachable while
    // holding their buffer manager and worker threads.
    await close().catch(() => {})
    throw err
  }

  return { run, rows, interrupt: () => conn.interrupt(), close }
}

/**
 * Open a session, run `fn`, and close it whatever happens. A leaked session
 * holds its DuckDB buffer manager, worker threads, and the libpq connection the
 * catalog ATTACH opened, so every caller needs this — use it unless you need
 * the session object itself (the diff races setup against a deadline).
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
