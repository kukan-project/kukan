/**
 * DuckLake integration (ADR-043 layer 2 / Phase ii). All DuckLake SQL lives in
 * this package; callers ask for operations (open a resource's catalog, ingest,
 * diff), not for statements.
 *
 * The exceptions are the DuckDB plumbing every reader of this bucket needs
 * whether or not it opens a catalog — the S3 secret, the extension
 * directory and loader, `sqlLiteral` — which live here because this is where
 * the knowledge of how to reach the bucket already was (ADR-055).
 */
export {
  LAKE_METADATA_SCHEMA,
  LAKE_DATA_PREFIX,
  lakeConfigFromEnv,
  lakeStorageUrl,
  loadDuckdbExtensions,
  forgetEnvironmentCredentials,
  s3SecretBody,
  usesCredentialChain,
  s3SettingsFromEnv,
} from './config'
export type { LakeConfig, LakeLimits, S3Settings } from './config'
export { openDuckdb, sealDuckdb } from './duckdb'
export type { DuckdbHandle } from './duckdb'
export { lakeTableName, lakeTableExists, currentSnapshotId } from './table'
export { sqlLiteral, sqlIdentifier } from './sql'
export { readRowGroupRows } from './parquet'
export { rowObjectsJson } from './json-rows'
export {
  openBucketSession,
  withBucketSession,
  closeLakeInstances,
  releaseIdleLakeInstances,
} from './connection'
export type { BucketSession, LakeSession, LakeRow } from './connection'
export {
  lakeResourcePrefix,
  lakeDataPrefix,
  lakeCatalogKey,
  parseLakeCatalogKey,
  lakeResourceOfKey,
  withLakeCatalogDraft,
  openLakeCatalogReader,
  withLakeCatalogReader,
  lakeCatalogFileNames,
  removeStaleLakeCatalogCopies,
} from './catalog'
export type {
  LakeObjectStore,
  LakeCatalogDraft,
  LakeCatalogCache,
  LakeCatalogReaderOptions,
} from './catalog'
export { ingestParquetVersion, keyFault } from './ingest'
export type { IngestResult } from './ingest'
// What it returns is `VersionDiff` from `@kukan/shared`: the panel renders those
// fields verbatim, so the shape is API surface and is declared with the view
// that carries it, not here.
export { diffVersions } from './diff'
