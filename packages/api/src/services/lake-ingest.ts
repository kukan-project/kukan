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
import { stillHeld, type ResourceClaim } from './pipeline-claim'
import { PARKED_UNTIL } from './storage-pointer'

/** A version, and the Parquet it still has to be ingested from. */
export interface DeferredIngest {
  resourceId: string
  version: number
  previewKey: string
  /**
   * The claim the writer holds, for the same reason the version row and the
   * live pointer carry one (ADR-044 §4): this is a write that stays with the
   * resource, and a run that has been stopped must not leave one behind.
   * Omitted by callers that hold no claim.
   */
  claim?: ResourceClaim | null
}

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
 *
 * Whatever key this displaces is parked in the same statement, for the reason
 * every other pointer move is (ADR-045 §3): while the version named it the
 * sweep read it as referenced and dropped its ledger record, so overwriting the
 * pointer on its own would leave that object with neither a pointer nor a
 * record — the one state the ledger exists to prevent.
 *
 * Only onto a version that is still waiting for one. A row that has been
 * ingested is not in `pendingLakeIngestQuery` any more, so a pointer set on it
 * afterwards is read by nobody and released by nobody: it would pin its Parquet
 * for good. A purged row must not be given a reference to content either.
 *
 * @returns whether the intent was recorded.
 */
export async function deferLakeIngest(
  db: Pick<Database, 'execute'>,
  row: DeferredIngest
): Promise<boolean> {
  const result = await db.execute(sql`
    WITH before AS (
      SELECT id, lake_source_key FROM resource_version
      WHERE resource_id = ${row.resourceId}::uuid
        AND version = ${row.version}
        AND state = 'active'
        AND ducklake_snapshot_id IS NULL
      FOR UPDATE
    ),
    deferred AS (
      UPDATE resource_version rv
      SET lake_source_key = ${row.previewKey}
      FROM before b
      WHERE rv.id = b.id
        AND ${stillHeld(row.claim)}
      RETURNING b.id, b.lake_source_key AS released
    ),
    parked AS (
      INSERT INTO orphaned_object (key, expires_at)
      SELECT released, ${PARKED_UNTIL} FROM deferred
      WHERE released IS NOT NULL AND released <> ${row.previewKey}
      ON CONFLICT (key) DO NOTHING
    )
    SELECT id FROM deferred
  `)
  return result.rows.length > 0
}

/**
 * The Parquet this version is still waiting to be ingested from, or null when
 * it is not waiting for one (ADR-043 §6-6).
 *
 * The retry asks the database rather than reading the key off its own message:
 * the row is what the sweep protects and what the hourly pass reads, so a
 * message that disagrees with it — one queued before the ingest landed, or
 * before someone abandoned it — has nothing to act on.
 */
export async function pendingLakeSourceKey(
  db: Pick<Database, 'select'>,
  row: { resourceId: string; version: number }
): Promise<string | null> {
  const [found] = await db
    .select({ key: resourceVersion.lakeSourceKey })
    .from(resourceVersion)
    .where(
      and(eq(resourceVersion.resourceId, row.resourceId), eq(resourceVersion.version, row.version))
    )
    .limit(1)
  return found?.key ?? null
}

/**
 * Let go of the Parquet a version was waiting on, and park it.
 *
 * The one way the pointer is ever dropped outside a successful ingest, so that
 * dropping it and handing the object to the sweep cannot come apart. While the
 * version named the key the sweep read it as referenced and dropped its ledger
 * record (ADR-045 §3) — cleared without parking, the object would be left with
 * neither a pointer nor a record.
 *
 * Conditional on the key it was asked about: an attempt that read the pointer,
 * decided to give up, and got here after another attempt recorded a different
 * Parquet must not withdraw that one's intent.
 *
 * Parking a key whose object is already gone costs nothing — the sweep asks the
 * backend, which answers that it is not there, and the record goes.
 *
 * @returns whether the pointer was the one given, and so was dropped.
 */
export async function releaseLakeSource(
  db: Pick<Database, 'execute'>,
  row: { resourceId: string; version: number; previewKey: string }
): Promise<boolean> {
  const result = await db.execute(sql`
    WITH released AS (
      UPDATE resource_version
      SET lake_source_key = NULL
      WHERE resource_id = ${row.resourceId}::uuid
        AND version = ${row.version}
        AND lake_source_key = ${row.previewKey}
      RETURNING id
    ),
    parked AS (
      INSERT INTO orphaned_object (key, expires_at)
      SELECT ${row.previewKey}, ${PARKED_UNTIL} FROM released
      ON CONFLICT (key) DO NOTHING
    )
    SELECT id FROM released
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
  if (newer) {
    // Refused for good, not deferred: no later pass can change the answer. The
    // pointer goes with the decision, or this version stays in the pending
    // count and its Parquet is pinned by a reference nothing will ever release.
    await releaseLakeSource(tx, row)
    return null
  }

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
