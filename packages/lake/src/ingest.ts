/**
 * DuckLake loads (ADR-043 layer 2 / Phase ii-a).
 *
 * Two things put contents into a table, and both go through {@link loadContents}
 * so a table is only ever written one way: a version's ingest, reading the
 * preview Parquet the Interpret step already produced (the types were inferred
 * once there, ADR-029, and are reused rather than re-parsed from CSV), and a
 * purge standing the table back on one of its own earlier snapshots.
 *
 * ii-a is keyless: each load replaces the table's contents wholesale. DuckLake's
 * copy-on-write keeps unchanged files shared between versions, so a full replace
 * still costs roughly the delta. Keyed MERGE lands in ii-b.
 */
import { describeColumns, sameColumns } from './columns'
import type { LakeSession } from './connection'
import { sqlLiteral } from './sql'
import { currentSnapshotId, lakeTableAt, lakeTableExists, lakeTableRef } from './table'

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

  if (await lakeTableExists(session, opts.table)) {
    await loadContents(session, ref, source)
  } else {
    await session.run(`CREATE TABLE ${ref} AS SELECT * FROM ${source}`)
  }
  return { snapshotId: await currentSnapshotId(session) }
}

/**
 * Stand a table back on the contents of one of its own earlier snapshots.
 *
 * The purge's step down off the version it retracted (spec §9.1 step 4). The
 * source is the table read at that snapshot rather than the version's Parquet
 * rebuilt out of layer 1, which would be a re-interpretation — and the write
 * goes through the same path an ingest takes, so the move costs a load rather
 * than a whole-table rewrite (spec §7.2).
 *
 * **Nothing comes back to record.** The contents are an old snapshot's, the
 * snapshot a new one — no catalog rewinds — but the landing is not a
 * publication, so no version row names it and `ducklake_snapshot_id` stays
 * written once (spec §7.2; §11-3 keeps the newest snapshot whether or not a
 * version names it).
 *
 * **The snapshot is read out before the load, and that is load-bearing.** A
 * `DELETE` inside the transaction takes the time-travel read of the same table
 * with it whenever the two share files — `t AT (VERSION => n)` then answers zero
 * rows and the move silently empties the table (pinned in
 * `merge.ducklake.test.ts`). ii-a never shares: every load replaces the contents
 * wholesale, so the head's files and an earlier version's are disjoint. ii-b's
 * keyed load updates in place, where they always share. Materializing first
 * costs one local copy on an operation that already rewrites every row, and it
 * takes the question out of the caller's hands.
 *
 * The caller must hold the ingest lock, and must have established that the table
 * is there — whether an absent one is a no-op or a fault is a question about the
 * version rows, which this package does not read.
 */
export async function restandLakeTable(
  session: LakeSession,
  opts: { table: string; snapshot: number }
): Promise<void> {
  const ref = lakeTableRef(opts.table)
  // Local to the session, so it commits no catalog snapshot and the load below
  // still lands exactly one. A fixed name is safe because every caller holds
  // the catalog-wide ingest lock.
  const source = 'lake_restand_source'
  await session.run(
    `CREATE OR REPLACE TEMP TABLE ${source} AS SELECT * FROM ${lakeTableAt(ref, opts.snapshot)}`
  )
  try {
    await loadContents(session, ref, source)
  } finally {
    await session.run(`DROP TABLE IF EXISTS ${source}`).catch(() => {})
  }
}

/**
 * Replace a table's contents with a relation's, as one snapshot.
 *
 * Two of the three branches spec §7.2 names. The keyed `MERGE` — the only one
 * that writes a delta — needs a declared key on both ends, which arrives with
 * ii-b; until then every load rewrites every row, and the column check is what
 * decides between the two shapes that can express it.
 */
async function loadContents(session: LakeSession, ref: string, source: string): Promise<void> {
  const existing = await describeColumns(session, ref)
  const incoming = await describeColumns(session, source)

  if (!sameColumns(existing, incoming)) {
    // Columns moved: there is nothing to insert into, so the table is replaced
    // outright. Older snapshots keep the old shape, so time travel to previous
    // versions still works — what the replace costs is the change feed across
    // it, not the history (spec §7.2).
    await session.run(`CREATE OR REPLACE TABLE ${ref} AS SELECT * FROM ${source}`)
    return
  }

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
