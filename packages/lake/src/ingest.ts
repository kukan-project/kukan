/**
 * DuckLake ingest (ADR-043 layer 2 / Phase ii-a).
 *
 * Loads a version's tabular content into its DuckLake table from the preview
 * Parquet the Interpret step already produced — the types were inferred once
 * there (ADR-029) and are reused rather than re-parsed from CSV.
 *
 * ii-a is keyless: each version replaces the table's contents wholesale.
 * DuckLake's copy-on-write keeps unchanged files shared between versions, so a
 * full replace still costs roughly the delta. Keyed MERGE lands in ii-b.
 */
import { describeColumns, sameColumns } from './columns'
import type { LakeSession } from './connection'
import { sqlLiteral } from './sql'
import { currentSnapshotId, lakeTableExists, lakeTableRef } from './table'

export interface IngestResult {
  /** Snapshot to record on the version; reading it reproduces this content. */
  snapshotId: number
}

/**
 * Ingest one version's Parquet into its DuckLake table.
 *
 * The caller must hold the ingest lock (`withLakeIngestLock`): the snapshot id
 * is read back as the catalog-wide maximum, which only identifies this commit
 * while writes are serialized.
 */
export async function ingestParquetVersion(
  session: LakeSession,
  opts: { table: string; parquetUrl: string }
): Promise<IngestResult> {
  const ref = lakeTableRef(opts.table)
  const source = `read_parquet(${sqlLiteral(opts.parquetUrl)})`

  if (!(await lakeTableExists(session, opts.table))) {
    await session.run(`CREATE TABLE ${ref} AS SELECT * FROM ${source}`)
    return { snapshotId: await currentSnapshotId(session) }
  }

  const existing = await describeColumns(session, ref)
  const incoming = await describeColumns(session, source)

  if (!sameColumns(existing, incoming)) {
    // Columns moved: replace the table outright. Older snapshots keep the old
    // shape, so time travel to previous versions still works.
    await session.run(`CREATE OR REPLACE TABLE ${ref} AS SELECT * FROM ${source}`)
  } else {
    // Same shape: one transaction so the replace lands as a single snapshot.
    await session.run('BEGIN TRANSACTION')
    try {
      await session.run(`DELETE FROM ${ref}`)
      await session.run(`INSERT INTO ${ref} SELECT * FROM ${source}`)
      await session.run('COMMIT')
    } catch (err) {
      await session.run('ROLLBACK').catch(() => {})
      throw err
    }
  }

  return { snapshotId: await currentSnapshotId(session) }
}
