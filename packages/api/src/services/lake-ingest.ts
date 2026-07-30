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
import type { IngestResult, LakeConfig, LakeSession } from '@kukan/lake'
import { ingestParquetVersion, lakeStorageUrl, lakeTableName } from '@kukan/lake'
import { LAKE_INGEST_LOCK, withGlobalAdvisoryLock } from './advisory-lock'
import { PARKED_UNTIL } from './storage-pointer'

/**
 * Record that a version still has to be ingested from `previewKey`
 * (ADR-043 §6-6).
 *
 * Here rather than at either caller because it is one half of a pair: the
 * statement below clears this column when the ingest lands, and a pointer that
 * is set in one package and cleared in another drifts. Both paths that give up
 * on an ingest — the pipeline's Lake step and the hourly sweep — reach it.
 *
 * What keeps the preview alive: the orphan sweep asks whether any pointer names
 * a key before deleting its object, and a key sitting in a queue message is a
 * reference it cannot see (ADR-045 §3). Recorded here, an ingest whose message
 * is lost is still found — and found wherever the version sits in the history.
 */
export async function deferLakeIngest(
  db: Pick<Database | Transaction, 'update'>,
  row: { resourceId: string; version: number; previewKey: string }
): Promise<void> {
  await db
    .update(resourceVersion)
    .set({ lakeSourceKey: row.previewKey })
    .where(
      and(eq(resourceVersion.resourceId, row.resourceId), eq(resourceVersion.version, row.version))
    )
}

/**
 * Give up on ingesting this version: it no longer needs a Parquet.
 *
 * The pointer is the record of intent, so an attempt that cannot be completed
 * has to withdraw it — otherwise the version stays in the pending count and the
 * hourly sweep re-selects it for ever. The object it named is not parked here:
 * this is reached when it is already gone.
 */
export async function abandonLakeIngest(
  db: Pick<Database | Transaction, 'update'>,
  row: { resourceId: string; version: number }
): Promise<void> {
  await db
    .update(resourceVersion)
    .set({ lakeSourceKey: null })
    .where(
      and(eq(resourceVersion.resourceId, row.resourceId), eq(resourceVersion.version, row.version))
    )
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
  lake: LakeConfig,
  row: { resourceId: string; version: number; previewKey: string }
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
  if (newer) return null

  const result = await ingestParquetVersion(session, {
    table: lakeTableName(row.resourceId),
    parquetUrl: lakeStorageUrl(lake, row.previewKey),
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
