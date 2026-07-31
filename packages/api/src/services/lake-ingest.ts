/**
 * DuckLake ingest under the catalog-wide lock (ADR-043 layer 2 / Phase ii-a).
 *
 * Shared by the pipeline's Lake step and the one-time backfill so the sequence
 * whose correctness depends on the lock — write, read the snapshot back, record
 * it on the version row — has exactly one implementation.
 */
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm'
import type { Database, Transaction } from '@kukan/db'
import { resourceVersion } from '@kukan/db'
import type { IngestResult, LakeSession } from '@kukan/lake'
import { ingestParquetVersion, lakeTableName } from '@kukan/lake'
import { LAKE_INGEST_LOCK, withGlobalAdvisoryLock } from './advisory-lock'
import { PARKED_UNTIL } from './storage-pointer'

/** A version, and where its rows are read from. */
export interface LakeIngestRow {
  resourceId: string
  version: number
  /**
   * The interpreted table on local disk (ADR-046). Every caller has one now —
   * the pipeline because the ingest runs inside its interpretation, the retry
   * because it interprets the version again. Which is why nothing has to keep
   * a preview alive between attempts: the input is the version file, and that
   * never changes.
   */
  sourcePath: string
}

/**
 * Let go of whatever Parquet a version is still pointing at, and park it.
 *
 * Only reached by rows written before ADR-046: nothing sets the pointer any
 * more, since a retry interprets the version file again rather than reading a
 * preview. What is left is clearing the ones already out there, which happens
 * where the version is refused for good — otherwise the object stays pinned by
 * a reference nothing will ever release.
 *
 * Clearing and parking cannot come apart. While the version named the key the
 * sweep read it as referenced and dropped its ledger record (ADR-045 §3), so a
 * clear on its own would leave an object with neither a pointer nor a record.
 *
 * Parking a key whose object is already gone costs nothing — the sweep asks the
 * backend, which answers that it is not there, and the record goes.
 *
 * @returns whether there was a pointer to drop.
 */
async function releaseLakeSource(
  db: Pick<Database, 'execute'>,
  row: { resourceId: string; version: number }
): Promise<boolean> {
  const result = await db.execute(sql`
    WITH before AS (
      SELECT id, lake_source_key FROM resource_version
      WHERE resource_id = ${row.resourceId}::uuid
        AND version = ${row.version}
        AND lake_source_key IS NOT NULL
      FOR UPDATE
    ),
    released AS (
      UPDATE resource_version rv SET lake_source_key = NULL
      FROM before b WHERE rv.id = b.id
      RETURNING b.lake_source_key AS key
    ),
    parked AS (
      INSERT INTO orphaned_object (key, expires_at)
      SELECT key, ${PARKED_UNTIL} FROM released
      ON CONFLICT (key) DO NOTHING
    )
    SELECT key FROM released
  `)
  return result.rows.length > 0
}

/**
 * Run `fn` while holding the DuckLake ingest lock. The transaction exists only
 * to scope the advisory lock; DuckLake commits on its own connection.
 */
export async function withLakeIngestLock<T>(
  db: Database,
  fn: (tx: Transaction) => Promise<T>
): Promise<T> {
  return withGlobalAdvisoryLock(db, LAKE_INGEST_LOCK, fn)
}

/**
 * Load one version's preview Parquet into DuckLake and record the snapshot it
 * committed as. Must run inside `withLakeIngestLock` — the snapshot is read
 * back as the catalog-wide maximum, which only identifies this commit while
 * writes are serialized. The caller owns both the lock and the session, so the
 * backfill can re-check its preconditions under the same lock and reuse one
 * session across the whole pass.
 *
 * Returns null when there is nothing to do, for either of two reasons.
 *
 * The version already carries a snapshot: ii-a ingests whole versions, so a
 * second pass would append every row again — and the retry path exists
 * precisely to run this after something else may have succeeded.
 *
 * Or a newer version is already in: ingesting replaces the table's contents, so
 * loading an older version now would leave the lake serving content the
 * resource no longer has, under a snapshot id above the newer version's. A
 * retry that waited while the next version went in is exactly how that happens.
 * The version stays un-ingested and its diffs stay unavailable, which is the
 * lesser harm — layer 2 is rebuildable from layer 1, a rewound table is not
 * detectable from it.
 */
export async function ingestVersionIntoLake(
  tx: Transaction,
  session: LakeSession,
  row: LakeIngestRow
): Promise<IngestResult | null> {
  const [pending] = await tx
    .select({ snapshot: resourceVersion.ducklakeSnapshotId })
    .from(resourceVersion)
    .where(
      and(
        eq(resourceVersion.resourceId, row.resourceId),
        eq(resourceVersion.version, row.version),
        eq(resourceVersion.state, 'active')
      )
    )
    .limit(1)
  if (!pending || pending.snapshot !== null) return null

  const [newer] = await tx
    .select({ version: resourceVersion.version })
    .from(resourceVersion)
    .where(
      and(
        eq(resourceVersion.resourceId, row.resourceId),
        gt(resourceVersion.version, row.version),
        isNotNull(resourceVersion.ducklakeSnapshotId)
      )
    )
    .limit(1)
  if (newer) {
    // Refused for good, not deferred: no later pass can change the answer. The
    // pointer goes with the decision, or this version stays in the pending
    // count and its Parquet is pinned by a reference nothing will ever release.
    await releaseLakeSource(tx, row)
    return null
  }

  const result = await ingestParquetVersion(session, {
    table: lakeTableName(row.resourceId),
    parquetUrl: row.sourcePath,
  })
  // The DuckLake commit is on its own connection, so a failure here leaves an
  // unreferenced snapshot — harmless, and reclaimed by expire.
  //
  // One statement, because letting go of the Parquet and parking it cannot come
  // apart: while the version named it the sweep read it as referenced and
  // dropped its ledger record (ADR-045 §3), so a clear on its own would leave an
  // object with neither a pointer nor a record — the one thing that ledger
  // exists to prevent. Parking a key something still references is harmless:
  // the next sweep reads it as referenced and drops the record again.
  await tx.execute(sql`
    WITH before AS (
      SELECT id, lake_source_key FROM resource_version
      WHERE resource_id = ${row.resourceId}::uuid AND version = ${row.version}
      FOR UPDATE
    ),
    ingested AS (
      UPDATE resource_version rv
      SET ducklake_snapshot_id = ${result.snapshotId}, lake_source_key = NULL
      FROM before b WHERE rv.id = b.id
      RETURNING b.lake_source_key AS released
    )
    INSERT INTO orphaned_object (key, expires_at)
    SELECT released, ${PARKED_UNTIL} FROM ingested WHERE released IS NOT NULL
    ON CONFLICT (key) DO NOTHING
  `)
  return result
}
