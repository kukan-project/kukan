/**
 * DuckLake writes under the catalog-wide lock (ADR-043 layer 2 / Phase ii-a).
 *
 * The sequence whose correctness depends on the lock — write, read the snapshot
 * back, record it on the version row — has exactly one implementation here, and
 * so does the question that reads those records back ({@link lakeStandsAhead}).
 * Four callers depend on them: the pipeline's Lake step, the one-time backfill,
 * a revert's reconcile, and a purge that rolls the live version back.
 */
import { and, desc, eq, gt, isNotNull, lt } from 'drizzle-orm'
import type { Database, Transaction } from '@kukan/db'
import { resourceVersion } from '@kukan/db'
import type { IngestResult, LakeSession } from '@kukan/lake'
import {
  ingestParquetVersion,
  lakeTableExists,
  lakeTableName,
  rollbackLakeTable,
} from '@kukan/lake'
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
 * Stand a resource's table on one version's rows, and record where that landed.
 *
 * The rollback restores the contents under a *new* snapshot, so the id is
 * written back against the version whose rows these now are. That is what lets a
 * later caller tell the table is already standing on it — neither the old id nor
 * the version rows say so by themselves. Must run inside `withLakeIngestLock`,
 * which is what makes the id read back identify this commit.
 *
 * Returns the snapshot it landed on, or null when there was no table to move.
 */
export async function standLakeTableOn(
  tx: Transaction,
  session: LakeSession,
  on: { resourceId: string; version: number; snapshot: number }
): Promise<number | null> {
  const table = lakeTableName(on.resourceId)
  if (!(await lakeTableExists(session, table))) return null
  const landed = await rollbackLakeTable(session, table, on.snapshot)
  await tx
    .update(resourceVersion)
    .set({ ducklakeSnapshotId: landed })
    .where(
      and(eq(resourceVersion.resourceId, on.resourceId), eq(resourceVersion.version, on.version))
    )
  return landed
}

/**
 * Does the table hold rows of a version that is no longer where it should
 * stand — some row carrying a snapshot above `snapshot`?
 *
 * Answered from the recorded ids alone, and only because every move of the
 * table writes the snapshot it landed on back onto the version whose rows those
 * now are ({@link standLakeTableOn}). Without that, this would stay true forever
 * after a revert and every asking would rewrite the table.
 */
export async function lakeStandsAhead(
  db: Pick<Database | Transaction, 'select'>,
  resourceId: string,
  snapshot: number | null
): Promise<boolean> {
  if (snapshot === null) return false
  const [ahead] = await db
    .select({ version: resourceVersion.version })
    .from(resourceVersion)
    .where(
      and(
        eq(resourceVersion.resourceId, resourceId),
        gt(resourceVersion.ducklakeSnapshotId, snapshot)
      )
    )
    .limit(1)
  return ahead !== undefined
}

/**
 * The version an ingest of `version` builds on: the newest active one below it
 * that reached the lake, or null when none did.
 */
async function lakeBaseBelow(
  tx: Transaction,
  resourceId: string,
  version: number
): Promise<{ version: number; snapshot: number } | null> {
  const [base] = await tx
    .select({ version: resourceVersion.version, snapshot: resourceVersion.ducklakeSnapshotId })
    .from(resourceVersion)
    .where(
      and(
        eq(resourceVersion.resourceId, resourceId),
        lt(resourceVersion.version, version),
        eq(resourceVersion.state, 'active'),
        isNotNull(resourceVersion.ducklakeSnapshotId)
      )
    )
    .orderBy(desc(resourceVersion.version))
    .limit(1)
  return base?.snapshot == null ? null : { version: base.version, snapshot: base.snapshot }
}

/**
 * Put the table where the ingest has to start from, and say so (ADR-043 §5).
 *
 * **An ingest applies to a table standing on the previous active version.** ii-a
 * gets away without it — every branch writes every row, so the contents land
 * right whatever they were before — but the *decision* it makes on the way,
 * "did the columns move?", is read off whatever the table happens to hold. After
 * a revert that is a version the resource stepped off. ii-b's `MERGE` takes the
 * same contents as its base, so the answer stops being cosmetic.
 *
 * The table stands ahead when some version carries a snapshot above the base's,
 * which a revert leaves behind whenever its own reconcile could not run. Reading
 * it here means the ingest repairs that rather than building on it.
 */
async function standOnBase(
  tx: Transaction,
  session: LakeSession,
  row: LakeIngestRow
): Promise<void> {
  const base = await lakeBaseBelow(tx, row.resourceId, row.version)
  if (!base) return
  if (!(await lakeStandsAhead(tx, row.resourceId, base.snapshot))) return
  await standLakeTableOn(tx, session, {
    resourceId: row.resourceId,
    version: base.version,
    snapshot: base.snapshot,
  })
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
 * Or a newer *active* version is already in: ingesting replaces the table's
 * contents, so loading an older version now would leave the lake serving content
 * the resource no longer has, under a snapshot id above the newer version's. A
 * retry that waited while the next version went in is exactly how that happens.
 * The version stays un-ingested and its diffs stay unavailable, which is the
 * lesser harm — layer 2 is rebuildable from layer 1, a rewound table is not
 * detectable from it.
 *
 * Active, because a revert steps the versions above its destination off and the
 * destination is then exactly what the table has to hold (ADR-043 §5). Counting
 * a superseded one would refuse the version the sweep queued for that very
 * reason, every hour, forever. This has to agree with `pendingLakeIngestQuery`:
 * disagreeing means either work that is listed and always turned away, or work
 * that is done without ever being listed.
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
        eq(resourceVersion.state, 'active'),
        isNotNull(resourceVersion.ducklakeSnapshotId)
      )
    )
    .limit(1)
  // No later pass can change the answer, and the pending query stops listing
  // this version the moment a newer one is in.
  if (newer) return null

  await standOnBase(tx, session, row)

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
