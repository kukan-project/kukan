/**
 * DuckLake ingest under the catalog-wide lock (ADR-043 layer 2 / Phase ii-a).
 *
 * Shared by the pipeline's Lake step and the one-time backfill so the sequence
 * whose correctness depends on the lock — write, read the snapshot back, record
 * it on the version row — has exactly one implementation.
 */
import { and, eq, gt, isNotNull } from 'drizzle-orm'
import type { Database, Transaction } from '@kukan/db'
import { resourceVersion } from '@kukan/db'
import type { IngestResult, LakeSession } from '@kukan/lake'
import { ingestParquetVersion, lakeTableName } from '@kukan/lake'
import { LAKE_INGEST_LOCK, withGlobalAdvisoryLock } from './advisory-lock'

/** A version, and where its rows are read from. */
export interface LakeIngestRow {
  resourceId: string
  version: number
  /**
   * The interpreted table on local disk (ADR-046). The pipeline has one because
   * the ingest runs inside its interpretation; the retry because it interprets
   * the version again.
   */
  sourcePath: string
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
  // No later pass can change the answer, and the pending query stops listing
  // this version the moment a newer one is in.
  if (newer) return null

  const result = await ingestParquetVersion(session, {
    table: lakeTableName(row.resourceId),
    parquetUrl: row.sourcePath,
  })
  // The DuckLake commit is on its own connection, so a failure here leaves an
  // unreferenced snapshot — harmless, and reclaimed by expire.
  await tx
    .update(resourceVersion)
    .set({ ducklakeSnapshotId: result.snapshotId })
    .where(
      and(eq(resourceVersion.resourceId, row.resourceId), eq(resourceVersion.version, row.version))
    )
  return result
}
