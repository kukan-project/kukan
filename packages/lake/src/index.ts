/**
 * DuckLake integration (ADR-043 layer 2 / Phase ii). All DuckLake SQL lives in
 * this package; callers ask for operations (ingest, diff, drop, stand back on a
 * snapshot), not for statements.
 *
 * The exceptions are the DuckDB plumbing every reader of this bucket needs
 * whether or not it attaches the catalogue — the S3 secret, the extension
 * directory and loader, `sqlLiteral` — which live here because this is where
 * the knowledge of how to reach the bucket already was (ADR-055).
 */
export {
  LAKE_METADATA_SCHEMA,
  LAKE_DATA_PREFIX,
  duckdbInstanceOptions,
  lakeConfigFromEnv,
  lakeStorageUrl,
  loadDuckdbExtensions,
  s3SecretBody,
  usesCredentialChain,
  s3SettingsFromEnv,
} from './config'
export type { LakeConfig, S3Settings } from './config'
export {
  lakeTableName,
  lakeTableExists,
  dropLakeTable,
  dropResourceTables,
  currentSnapshotId,
  snapshotIds,
  resolvableSnapshots,
} from './table'
export { sqlLiteral, sqlIdentifier } from './sql'
export { readRowGroupRows } from './parquet'
export { openLakeSession, withLakeSession, closeLakeInstances } from './connection'
export type { LakeSession, LakeSessionOptions, LakeRow } from './connection'
export { ingestParquetVersion, keyFault, restandLakeTable } from './ingest'
export type { IngestResult } from './ingest'
// What it returns is `VersionDiff` from `@kukan/shared`: the panel renders those
// fields verbatim, so the shape is API surface and is declared with the view
// that carries it, not here.
export { diffVersions } from './diff'
export { deleteOrphanedFiles, reclaimUnreferencedSnapshots } from './maintenance'
export type { ReclaimResult } from './maintenance'
