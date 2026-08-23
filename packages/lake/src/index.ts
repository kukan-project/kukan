/**
 * DuckLake integration (ADR-043 layer 2 / Phase ii). All DuckLake SQL lives in
 * this package; callers ask for operations (ingest, diff, drop, stand back on a
 * snapshot), not for statements.
 */
export { LAKE_METADATA_SCHEMA, LAKE_DATA_PREFIX, lakeConfigFromEnv, lakeStorageUrl } from './config'
export type { LakeConfig } from './config'
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
export { openLakeSession, withLakeSession, closeLakeInstances } from './connection'
export type { LakeSession, LakeRow } from './connection'
export { ingestParquetVersion, keyFault, restandLakeTable } from './ingest'
export type { IngestResult } from './ingest'
// What it returns is `VersionDiff` from `@kukan/shared`: the panel renders those
// fields verbatim, so the shape is API surface and is declared with the view
// that carries it, not here.
export { diffVersions } from './diff'
export { deleteOrphanedFiles, reclaimUnreferencedSnapshots } from './maintenance'
export type { ReclaimResult } from './maintenance'
