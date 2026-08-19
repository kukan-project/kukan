/**
 * DuckLake writes under the catalog-wide lock (ADR-043 layer 2 / Phase ii-a).
 *
 * The sequence whose correctness depends on the lock — write, read the snapshot
 * back, record it on the version row — has exactly one implementation here, and
 * so does the question that reads those records back ({@link lakeStandsAhead}).
 * Four callers depend on them: the pipeline's Lake step, the one-time backfill,
 * a revert's reconcile, and a purge coming off the version it retracted.
 */
import { and, desc, eq, gt, isNotNull, lt } from 'drizzle-orm'
import type { Database, Transaction } from '@kukan/db'
import { resourceVersion } from '@kukan/db'
import type { IngestResult, LakeSession } from '@kukan/lake'
import {
  ingestParquetVersion,
  lakeTableExists,
  lakeTableName,
  resolvableSnapshots,
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

/** A version, and the snapshot layer 2 holds its rows under. */
export interface LakeStand {
  version: number
  snapshot: number
}

/**
 * The versions layer 2 can be stood on, newest first: still standing, and
 * carrying a snapshot.
 *
 * **This is not layer 1's restore target, and reading one for the other loses
 * the table** (spec §9.1). A version live enough for the pointer need never have
 * reached the lake — too large, not tabular, in ii-b an unusable key — so "the
 * newest version still standing" and "the newest version whose rows the lake
 * holds" name different versions as soon as one of those sits between two
 * ingested ones. Standing the table on the layer 1 answer then reads as "no
 * target at all" and drops it. What that costs is the contents, not the history:
 * the retained snapshots stay readable through a drop (pinned in
 * `maintenance.ducklake.test.ts`), while nothing brings the contents back —
 * surviving rows still carry their snapshot ids, and the sweep only looks for
 * versions without one.
 *
 * **`active` only**, which since ADR-044's revert became a publish is every
 * version but a tombstone: content a revert moved off keeps its state, and the
 * version published above it is what layer 2 follows. With no active version
 * left to stand on, an empty table says what is true — layer 2 has no current
 * contents — where retracted rows would be the base ii-b's `MERGE` builds the
 * next version on.
 *
 * @param opts.below - only versions under this one, for an ingest asking what it
 * builds on rather than where the table should stand.
 */
export async function versionsLakeCanStandOn(
  db: Pick<Database | Transaction, 'select'>,
  resourceId: string,
  opts: { below?: number; limit?: number } = {}
): Promise<LakeStand[]> {
  const query = db
    .select({ version: resourceVersion.version, snapshot: resourceVersion.ducklakeSnapshotId })
    .from(resourceVersion)
    .where(
      and(
        eq(resourceVersion.resourceId, resourceId),
        eq(resourceVersion.state, 'active'),
        isNotNull(resourceVersion.ducklakeSnapshotId),
        opts.below === undefined ? undefined : lt(resourceVersion.version, opts.below)
      )
    )
    .orderBy(desc(resourceVersion.version))
  const rows = await (opts.limit === undefined ? query : query.limit(opts.limit))
  return rows.flatMap((row) =>
    row.snapshot === null ? [] : [{ version: row.version, snapshot: row.snapshot }]
  )
}

/**
 * The version layer 2 should be standing on but is not, or null when there is
 * nothing for the caller to do.
 *
 * **The one place that pairs the two halves of that question**, because the three
 * callers that ask it have to agree: a revert's reconcile does the move,
 * {@link ResourceVersionService.lakeOwed} decides whether the screen still offers
 * it, and an ingest repairs the base it is about to build on. Two of them reading
 * different halves is what left a table on retracted rows with nothing saying so.
 *
 * **Null covers two states deliberately** — the table already stands right, and no
 * surviving version can be stood on. All three callers want the same thing of
 * both: nothing. A revert that empties a resource therefore leaves the table on
 * the rows it retracted, which it owes no better (spec §9.1) and nothing resolves
 * to (spec §14.1-16). A purge is the caller that has to tell them apart, because
 * it owes unfetchability — it asks {@link resolvedLakeStand} and drops the table
 * on a null of the second kind.
 */
export async function lakeMoveOwed(
  db: Pick<Database | Transaction, 'select'>,
  resourceId: string,
  opts: { below?: number } = {}
): Promise<LakeStand | null> {
  const [stand] = await versionsLakeCanStandOn(db, resourceId, { ...opts, limit: 1 })
  if (!stand) return null
  return (await lakeStandsAhead(db, resourceId, stand.snapshot)) ? stand : null
}

/**
 * The newest version the table can be stood on *and* the catalog still resolves.
 * Null only when no version could be stood on at all.
 *
 * The recorded ids are not enough by themselves: a version can carry a snapshot
 * the catalog has expired away (spec §11-5), and rolling onto one of those fails
 * — leaving a purge stuck on a table that still serves what it retracted.
 * Stepping down to one that resolves costs only history no reader could reach.
 *
 * **Throws rather than answering null when every recorded id is unresolvable.**
 * Null tells the caller nothing survives, and dropping a table in that state is
 * permanent: those versions keep their ids, so the sweep — which looks for
 * versions *without* one — passes over them, and §11-5's repair (null the
 * unresolvable ids, let the sweep re-ingest from layer 1) is not implemented.
 * Failing leaves the work outstanding, visible and retried.
 */
export async function resolvedLakeStand(
  db: Pick<Database | Transaction, 'select'>,
  session: LakeSession,
  resourceId: string
): Promise<LakeStand | null> {
  const stands = await versionsLakeCanStandOn(db, resourceId)
  if (stands.length === 0) return null
  const resolvable = await resolvableSnapshots(
    session,
    stands.map((s) => s.snapshot)
  )
  const stand = stands.find((s) => resolvable.has(s.snapshot))
  if (!stand) {
    throw new Error(
      `Layer 2 for resource ${resourceId} records no snapshot the catalog resolves ` +
        `(${stands.map((s) => `v${s.version}@${s.snapshot}`).join(', ')})`
    )
  }
  return stand
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
  const base = await lakeMoveOwed(tx, row.resourceId, { below: row.version })
  if (!base) return
  await standLakeTableOn(tx, session, { resourceId: row.resourceId, ...base })
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
 * Active, which is every version a purge has not taken. This has to agree with
 * `pendingLakeIngestQuery`: disagreeing means either work that is listed and
 * always turned away, or work that is done without ever being listed.
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
