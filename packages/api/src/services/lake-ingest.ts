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
import { ingestParquetVersion, keyFault, lakeTableName, resolvableSnapshots } from '@kukan/lake'
import { keyColumnsOf, sharedKeyColumns } from '@kukan/shared'
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
 * (ADR-044 §4).
 *
 * **This is where the table can stand, not what it holds.** `active` leaves out
 * the version a purge has claimed and not yet stepped the table down from, which
 * is exactly the row that can be holding the contents — {@link lakeHead} is that
 * question, and confusing the two is how an ingest would match its rows against
 * contents identified some other way.
 */
export async function versionsLakeCanStandOn(
  db: Pick<Database | Transaction, 'select'>,
  resourceId: string
): Promise<LakeStand[]> {
  const rows = await db
    .select({
      version: resourceVersion.version,
      snapshot: resourceVersion.ducklakeSnapshotId,
    })
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

/** What the table holds, and whether the row saying so can still be trusted. */
export interface LakeHead extends LakeStand {
  /**
   * The key those contents were loaded under (spec §6.4) — what an ingest has to
   * match against before it can apply rows rather than replace them. Only the
   * head carries it: where the table *can* stand says nothing about how its
   * current rows are identified.
   */
  keyColumns: string[] | null
  /**
   * Its version is being purged, which makes the recorded id **indeterminate**:
   * the step-down commits in DuckLake before the purge nulls the id (spec §9.1
   * steps 4 and 6), so between those the row names a snapshot whose contents the
   * table may already have stepped off — and nothing in the row says which side
   * of that it is on. A reader that has to know what the contents are identified
   * by cannot use it.
   */
  purging: boolean
}

/**
 * The version whose rows the table holds, or null when it holds none.
 *
 * **Not "where it can stand" ({@link versionsLakeCanStandOn}), and not `active`
 * only.** A purge takes its version out of the active set the moment it is
 * claimed and steps the table down later, in a worker; in between the rows are
 * still that version's. Read from the active set, this answers with a version
 * the table stepped off long ago — and an ingest would then match its rows
 * against contents identified some other way, which is the one thing the shared
 * key exists to prevent (spec §6.6).
 *
 * The highest recorded snapshot, whatever state the row is in now: every load
 * commits above everything recorded, so that is the one written last, and a
 * tombstone cannot appear because a purge nulls the id as it completes.
 */
export async function lakeHead(
  db: Pick<Database | Transaction, 'select'>,
  resourceId: string
): Promise<LakeHead | null> {
  const [head] = await db
    .select({
      version: resourceVersion.version,
      snapshot: resourceVersion.ducklakeSnapshotId,
      keyColumns: resourceVersion.lakeKeyColumns,
      state: resourceVersion.state,
    })
    .from(resourceVersion)
    .where(
      and(eq(resourceVersion.resourceId, resourceId), isNotNull(resourceVersion.ducklakeSnapshotId))
    )
    .orderBy(desc(resourceVersion.ducklakeSnapshotId))
    .limit(1)
  if (head?.snapshot == null) return null
  const { state, ...stand } = head
  return { ...stand, snapshot: head.snapshot, purging: state === 'purging' }
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
 * version was loaded last, so *where it stands* is the highest recorded id
 * ({@link lakeHead}, whatever state that row is in now) and *where it goes* is
 * the highest still standing. **Version numbers cannot answer
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
  // Asked of what the table holds, which a version already claimed for purge can
  // be: two of a resource's versions can be on their way out at once, and the one
  // loaded last is whose rows would be stepped off.
  const head = await lakeHead(db, resourceId)
  if (head !== null && head.snapshot > purgedSnapshot) return { move: 'stays' }
  // Where it can go is the other question, and that one is `active` only: a
  // version being purged is not somewhere to put the contents back.
  const stands = await versionsLakeCanStandOn(db, resourceId)
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
 * Returns null when there is nothing to do, for three reasons — and the last
 * one writes a row on the way out.
 *
 * The version already carries a snapshot: a load applies or replaces whole
 * versions, so a second pass would write the same rows again — and the retry
 * path exists precisely to run this after something else may have succeeded.
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
 * Or its key cannot identify its rows. That one is recorded on the version
 * (spec §6.6) and takes it out of the sweep, because nothing about the fault is
 * answerable from the row — a composite key's uniqueness is not in the frozen
 * schema, so a version listed without it would be handed out and turned away for
 * ever.
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
 * A keyless load would not notice either way — it writes every row — but the
 * decision it makes on the way, "did the columns move?", is read off whatever
 * the table holds, and a keyed one matches its rows against them.
 */
export async function ingestVersionIntoLake(
  tx: Transaction,
  session: LakeSession,
  row: LakeIngestRow
): Promise<IngestResult | null> {
  const [pending] = await tx
    .select({
      snapshot: resourceVersion.ducklakeSnapshotId,
      keyColumns: resourceVersion.lakeKeyColumns,
    })
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

  const keyColumns = keyColumnsOf(pending.keyColumns)
  // The key both ends are identified by, or null when they are not the same —
  // the question §7.2 has the ingest, the purge's step-down and the diff share.
  // Asked only of a keyed version: for every other the answer is null, and this
  // is a query on the locked connection.
  let key: string[] | null = null
  if (keyColumns) {
    // Refused before anything is written, and recorded where the sweep can see
    // it (spec §6.6): the alternative is a version listed as outstanding for
    // ever and turned away every hour. Written once — the same bytes under the
    // same key reach the same answer — and a key change makes a version of its
    // own to try.
    const fault = await keyFault(session, { parquetUrl: row.sourcePath, keys: keyColumns })
    if (fault) {
      await tx
        .update(resourceVersion)
        .set({ lakeIngestReason: fault })
        .where(
          and(
            eq(resourceVersion.resourceId, row.resourceId),
            eq(resourceVersion.version, row.version)
          )
        )
      return null
    }
    const head = await lakeHead(tx, row.resourceId)
    // A head being purged cannot say what the contents are identified by: its id
    // is recorded until the purge's last step, while the step-down that moved
    // the contents off it committed earlier. Keyless is sound either way, and
    // this version keeps its own key for the load after it.
    if (head !== null && !head.purging) key = sharedKeyColumns(head.keyColumns, keyColumns)
  }

  const result = await ingestParquetVersion(session, {
    table: lakeTableName(row.resourceId),
    parquetUrl: row.sourcePath,
    key,
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
