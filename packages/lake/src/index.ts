/**
 * DuckLake integration (ADR-043 layer 2 / Phase ii). All DuckLake SQL lives in
 * this package; callers ask for operations (ingest, diff, drop, roll back), not
 * for statements.
 */
export {
  LAKE_METADATA_SCHEMA,
  LAKE_DATA_PREFIX,
  LAKE_PREVIEW_SUFFIX,
  isLakeIngestable,
  lakeConfigFromEnv,
  lakeStorageUrl,
} from './config'
export type { LakeConfig } from './config'
export {
  lakeTableName,
  lakeTableExists,
  dropLakeTable,
  dropResourceTables,
  rollbackLakeTable,
} from './table'
export { sqlLiteral } from './sql'
export { openLakeSession, withLakeSession } from './connection'
export type { LakeSession, LakeRow } from './connection'
export { ingestParquetVersion } from './ingest'
export type { IngestResult } from './ingest'
export { diffVersions } from './diff'
export type { VersionDiff } from './diff'
