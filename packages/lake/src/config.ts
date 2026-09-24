/**
 * DuckLake configuration (ADR-043 layer 2 / Phase ii).
 * Catalog = the app's PostgreSQL (dedicated schema); data files = the app's
 * S3/MinIO bucket under a dedicated prefix. Derived from the existing DB and
 * storage env — no new required variables.
 */
import type { Env } from '@kukan/shared'
import { sqlLiteral } from './sql'

/** PostgreSQL schema that DuckLake owns for its catalog tables (not Drizzle-managed). */
export const LAKE_METADATA_SCHEMA = 'ducklake'
/** Storage key prefix for DuckLake data files (Parquet). */
export const LAKE_DATA_PREFIX = 'lake/'

export interface LakeConfig {
  /** libpq keyword connection string for the DuckLake catalog. */
  pgConnString: string
  bucket: string
  region: string
  /** S3-compatible endpoint host:port (MinIO); undefined for AWS S3. */
  s3Endpoint?: string
  s3UseSsl: boolean
  s3AccessKey?: string
  s3SecretKey?: string
}

/**
 * Full `s3://` URL for a storage key, for DuckDB's `read_parquet`.
 *
 * For a key held by the storage adapter, `StorageAdapter.readUrl(key)` answers
 * the same question from the object's own owner — and a test double can point
 * it at a local file, which this cannot. Use that one outside the lake.
 */
export function lakeStorageUrl(config: LakeConfig, key: string): string {
  return `s3://${config.bucket}/${key}`
}

/**
 * Seconds libpq waits for the catalog connection during ATTACH.
 *
 * ATTACH runs inside DuckDB and cannot be interrupted from Node, so a caller
 * that gives up on a deadline abandons it rather than cancelling it. Without a
 * bound, an unreachable catalog would leave one such connection attempt behind
 * per request and they would accumulate.
 */
const LAKE_PG_CONNECT_TIMEOUT_S = 10

export function lakeConfigFromEnv(env: Env): LakeConfig {
  // DuckLake's ATTACH takes a libpq keyword string, not a URL.
  const pgConnString =
    `host=${env.POSTGRES_HOST} port=${env.POSTGRES_PORT} dbname=${env.POSTGRES_DB} ` +
    `user=${env.POSTGRES_USER} password=${env.POSTGRES_PASSWORD} ` +
    `sslmode=${env.POSTGRES_SSLMODE} connect_timeout=${LAKE_PG_CONNECT_TIMEOUT_S}`

  // MinIO endpoints are given as a URL (http://host:9000); DuckDB wants host:port + a ssl flag.
  let s3Endpoint: string | undefined
  let s3UseSsl = true
  if (env.S3_ENDPOINT) {
    const url = new URL(env.S3_ENDPOINT)
    s3Endpoint = url.host
    s3UseSsl = url.protocol === 'https:'
  }

  return {
    pgConnString,
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    s3Endpoint,
    s3UseSsl,
    s3AccessKey: env.S3_ACCESS_KEY,
    s3SecretKey: env.S3_SECRET_KEY,
  }
}

/**
 * Instance options that put DuckDB's extensions where the image installed them.
 *
 * DuckDB does not read `DUCKDB_EXTENSION_DIRECTORY` itself — it is this repo's
 * convention, set by the Dockerfile, and without passing it a load looks in the
 * default location, finds nothing, and reaches for extensions.duckdb.org, which
 * a closed-network deployment cannot do.
 */
export function duckdbInstanceOptions(): { extension_directory: string } | undefined {
  const dir = process.env.DUCKDB_EXTENSION_DIRECTORY
  return dir ? { extension_directory: dir } : undefined
}

/**
 * What DuckDB needs to reach the bucket — the S3 half of {@link LakeConfig},
 * which is all a caller that only reads Parquet has to hold. The feed (ADR-055)
 * is such a caller: it was assembling a whole lake config, PostgreSQL
 * connection string and all, to build one secret.
 */
export type S3Settings = Pick<
  LakeConfig,
  'bucket' | 'region' | 's3Endpoint' | 's3UseSsl' | 's3AccessKey' | 's3SecretKey'
>

/** The S3 half of the environment, without the catalog's. */
export function s3SettingsFromEnv(env: Env): S3Settings {
  const { bucket, region, s3Endpoint, s3UseSsl, s3AccessKey, s3SecretKey } = lakeConfigFromEnv(env)
  return { bucket, region, s3Endpoint, s3UseSsl, s3AccessKey, s3SecretKey }
}

/**
 * Whether the secret has to resolve credentials itself rather than being
 * handed a key pair. It also decides whether the `aws` extension is worth
 * loading: that extension exists to back `PROVIDER credential_chain`, and
 * loading it costs ~12 ms a session that a deployment with static keys
 * (MinIO, and every Compose install) never gets back.
 */
export function usesCredentialChain(config: S3Settings): boolean {
  return !(config.s3AccessKey && config.s3SecretKey)
}

/**
 * The `CREATE SECRET` body for reading this deployment's bucket.
 *
 * With an explicit endpoint (MinIO) path-style addressing and the ssl flag have
 * to be forced; against AWS S3 the endpoint is omitted.
 *
 * Without static keys we are on AWS with only a task role, so the secret has to
 * resolve credentials itself: DuckDB's default provider is `config`, which
 * would sign with empty keys and get a 403 from a private bucket.
 *
 * **`REFRESH auto` is what keeps that working past the first few hours.** The
 * chain is resolved once at `CREATE SECRET`, an instance outlives that, and
 * task-role credentials expire — after which every S3 request fails with
 * ExpiredToken until the process restarts. It is written here, once, because
 * that failure took a production environment out and is invisible until hours
 * after a deploy.
 *
 * `scope` narrows which paths the secret is offered for; the lake leaves it
 * open, the OData feed pins it to the bucket (ADR-055).
 */
export function s3SecretBody(config: S3Settings, scope?: string): string {
  const staticKeys = !usesCredentialChain(config)
  return [
    `TYPE s3`,
    `REGION ${sqlLiteral(config.region)}`,
    ...(staticKeys
      ? [`KEY_ID ${sqlLiteral(config.s3AccessKey!)}`, `SECRET ${sqlLiteral(config.s3SecretKey!)}`]
      : [`PROVIDER credential_chain`, `REFRESH auto`]),
    ...(config.s3Endpoint
      ? [
          `ENDPOINT ${sqlLiteral(config.s3Endpoint)}`,
          `URL_STYLE 'path'`,
          `USE_SSL ${config.s3UseSsl}`,
        ]
      : []),
    ...(scope ? [`SCOPE ${sqlLiteral(scope)}`] : []),
  ].join(', ')
}

/**
 * Load the extensions a session needs, explicitly.
 *
 * Autoloading would reach for extensions.duckdb.org on first use — fatal on a
 * closed-network deployment even though the image ships them — so every
 * session names what it wants and then turns autoloading off. `INSTALL` finds
 * what the image installed (see {@link duckdbInstanceOptions}) and does not go
 * looking for more.
 */
export async function loadDuckdbExtensions(
  conn: { run(sql: string): Promise<unknown> },
  extensions: readonly string[]
): Promise<void> {
  for (const ext of extensions) {
    await conn.run(`INSTALL ${ext}`)
    await conn.run(`LOAD ${ext}`)
  }
}
