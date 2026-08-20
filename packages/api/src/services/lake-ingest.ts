/**
 * What the version rows say about layer 2, under the catalog-wide lock (ADR-043
 * layer 2 / Phase ii-a).
 *
 * Two things need the lock and both live here. **Loading a version**: write, read
 * the snapshot back, record it on the version row — the pipeline's Lake step is
 * the caller, and the sweep's retries reach it through the same step. **Standing
 * the table down**: where the table is and where a purge can take it, which is
 * read off the same rows and records nothing (spec §7.2).
 */
import { and, desc, eq, gt, isNotNull } from 'drizzle-orm'
import type { Database, Transaction } from '@kukan/db'
import { resourceVersion } from '@kukan/db'
import type { IngestResult, LakeSession } from '@kukan/lake'
import { ingestParquetVersion, lakeTableName, resolvableSnapshots } from '@kukan/lake'
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
 * **Ordered by the recorded snapshot, newest load first — not by version
 * number.** The two agree for everything write-once recorded, and disagree
 * wherever a row the old scheme rewrote before the conversion survives
 * (ADR-044 §4). The load order is the one that answers both of
 * {@link lakeStandDown}'s questions, and asking them in different orders is what
 * left a purged version's rows as the table's contents.
 */
export async function versionsLakeCanStandOn(
  db: Pick<Database | Transaction, 'select'>,
  resourceId: string
): Promise<LakeStand[]> {
  const rows = await db
    .select({ version: resourceVersion.version, snapshot: resourceVersion.ducklakeSnapshotId })
    .from(resourceVersion)
    .where(
      and(
        eq(resourceVersion.resourceId, resourceId),
        eq(resourceVersion.state, 'active'),
        isNotNull(resourceVersion.ducklakeSnapshotId)
      )
    )
    .orderBy(desc(resourceVersion.ducklakeSnapshotId))
  return rows.flatMap((row) =>
    row.snapshot === null ? [] : [{ version: row.version, snapshot: row.snapshot }]
  )
}

/** Where a purge has to leave the table, once it has taken its version out. */
export type LakeStandDown =
  /** On rows loaded after the purged version's — another version's, so untouched. */
  | { move: 'stays' }
  /** Nowhere left to stand: the table says so by holding nothing. */
  | { move: 'drop' }
  /** Onto this snapshot's contents, through the ingest path (spec §7.2). */
  | { move: 'onto'; snapshot: number }

/**
 * Where the table stands and where the purge can take it — **one answer, off one
 * order**, because the two halves have to agree about what the table holds.
 *
 * Both are read from the recorded snapshots: the table holds the rows of whichever
 * version was loaded last, so *where it stands* is the highest recorded id and
 * *where it goes* is the highest that is left. **Version numbers cannot answer
 * either.** They agree with the load order for everything write-once recorded, and
 * disagree wherever a row the old scheme rewrote survives the conversion (ADR-044
 * §4) — and picking the target by version there is what breaks the next purge:
 * with v1@13 and v2@9 both active, standing the table down onto v2 leaves the head
 * holding v2's rows while v1 still records the higher id, so purging v2 reads
 * "something was loaded after me" and leaves the purged rows as the contents.
 *
 * **Stepping to the highest id keeps that from arising**: after every step-down the
 * head holds the rows of the highest-recorded surviving version, which is what the
 * next purge asks about. An ingest maintains the same thing, since its snapshot is
 * the catalog's newest. The one state that still escapes it is a version whose id
 * the catalog cannot resolve staying above the one stood on (spec §11-5, §14.1-15).
 *
 * The recorded ids are not enough by themselves for the target: a version can
 * carry a snapshot the catalog has expired away (spec §11-5), and standing on one
 * of those fails — leaving a purge stuck on a table that still serves what it
 * retracted. Stepping down to one that resolves costs only history no reader could
 * reach.
 *
 * **Throws rather than answering `drop` when every recorded id is unresolvable.**
 * `drop` tells the caller nothing survives, and dropping a table in that state is
 * permanent: those versions keep their ids, so the sweep — which looks for
 * versions *without* one — passes over them, and §11-5's repair (null the
 * unresolvable ids, let the sweep re-ingest from layer 1) is not implemented.
 * Failing leaves the work outstanding, visible and retried.
 */
export async function lakeStandDown(
  db: Pick<Database | Transaction, 'select'>,
  session: LakeSession,
  resourceId: string,
  purgedSnapshot: number
): Promise<LakeStandDown> {
  // Newest load first, so the head is the first entry and the target is the
  // first one that still resolves — the same walk answers both.
  const stands = await versionsLakeCanStandOn(db, resourceId)
  if (stands[0] !== undefined && stands[0].snapshot > purgedSnapshot) return { move: 'stays' }
  if (stands.length === 0) return { move: 'drop' }

  const resolvable = await resolvableSnapshots(
    session,
    stands.map((stand) => stand.snapshot)
  )
  const stand = stands.find((s) => resolvable.has(s.snapshot))
  if (!stand) {
    throw new Error(
      `Layer 2 for resource ${resourceId} records no snapshot the catalog resolves ` +
        `(${stands.map((s) => `v${s.version}@${s.snapshot}`).join(', ')})`
    )
  }
  return { move: 'onto', snapshot: stand.snapshot }
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
 *
 * **The table it loads onto holds the contents of the version loaded last**,
 * which nothing here has to arrange: the refusal above keeps an older version
 * from replacing a newer one's contents, a revert publishes forward instead of
 * moving contents (spec §7.2), and a purge stands the table down as it goes.
 * Every load commits above everything recorded, so the version it loads becomes
 * the last one in turn.
 *
 * **That is the version carrying the highest recorded snapshot, which is not
 * always the highest version number.** They agree for everything write-once
 * recorded; where an id the old scheme rewrote survives the conversion
 * (ADR-044 §4), an older version's rows are what the table holds — reading the
 * base as "the previous active version" there would stand it on contents the
 * table does not have. {@link lakeStandDown} answers the same question for a
 * purge, off the same order.
 *
 * ii-a would not notice either way — every branch writes every row — but the
 * decision it makes on the way, "did the columns move?", is read off whatever
 * the table holds, and ii-b's `MERGE` takes those contents as its base.
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
