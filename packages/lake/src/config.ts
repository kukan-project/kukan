/**
 * DuckLake configuration (ADR-043 layer 2 / Phase ii).
 * Catalog = the app's PostgreSQL (dedicated schema); data files = the app's
 * S3/MinIO bucket under a dedicated prefix. Derived from the existing DB and
 * storage env — no new required variables.
 */
import type { Env } from '@kukan/shared'

/** PostgreSQL schema that DuckLake owns for its catalog tables (not Drizzle-managed). */
export const LAKE_METADATA_SCHEMA = 'ducklake'
/** Storage key prefix for DuckLake data files (Parquet). */
export const LAKE_DATA_PREFIX = 'lake/'

/**
 * Layer 2 ingests the preview Parquet, so it covers exactly the resources
 * Extract renders as Parquet (CSV/TSV under the size cap). Other previews —
 * notably a ZIP's JSON manifest — are not tabular and must not reach
 * `read_parquet`. The backfill applies the same rule in SQL (`LIKE '%' || the
 * suffix`), so the constant is what keeps the two from drifting.
 */
export const LAKE_PREVIEW_SUFFIX = '.parquet'

export function isLakeIngestable(previewKey: string | null | undefined): previewKey is string {
  return previewKey != null && previewKey.endsWith(LAKE_PREVIEW_SUFFIX)
}

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

/** Full `s3://` URL for a storage key, for DuckDB's `read_parquet`. */
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
