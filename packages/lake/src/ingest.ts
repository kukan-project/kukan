/**
 * DuckLake loads (ADR-043 layer 2 / Phase ii-a).
 *
 * Two things put contents into a table, and both go through {@link loadContents}
 * so a table is only ever written one way: a version's ingest, reading the
 * preview Parquet the Interpret step already produced (the types were inferred
 * once there, ADR-029, and are reused rather than re-parsed from CSV), and a
 * purge standing the table back on one of its own earlier snapshots.
 *
 * **Given a key both ends share, the load applies rows rather than replacing
 * them** (ii-b): update what changed, insert what is new, delete what the
 * version no longer carries. Without one — no key, or contents identified some
 * other way — it replaces them wholesale, which DuckLake's copy-on-write still
 * keeps to roughly the delta. Which of the two is not this package's decision to
 * make: it rests on what a version row says (spec §7.2), and the caller resolves
 * it before calling.
 */
import type { LakeIngestReason } from '@kukan/shared'
import { describeColumns, sameColumns } from './columns'
import type { LakeSession } from './connection'
import { keyedLoadSql } from './keyed-load'
import { sqlIdentifier, sqlLiteral } from './sql'
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
  opts: {
    table: string
    parquetUrl: string
    /**
     * **The key both ends share**, or null when there is none to match rows by
     * (spec §7.2). Not the version's own key: a `MERGE` matches the incoming
     * rows against contents that were identified some other way, and the key's
     * uniqueness is only ever checked on the version being loaded (spec §6.6) —
     * so under the base's key the table may hold duplicates of it, which
     * DuckLake resolves by dropping a row without saying so.
     *
     * Resolved by the caller because it rests on the version rows, which this
     * package does not read. The purge's step-down and the diff's first stage
     * ask the same question of the same two lists.
     */
    key?: string[] | null
  }
): Promise<IngestResult> {
  const ref = lakeTableRef(opts.table)
  const source = `read_parquet(${sqlLiteral(opts.parquetUrl)})`

  if (await lakeTableExists(session, opts.table)) {
    await loadContents(session, ref, source, opts.key ?? null)
  } else {
    // Nothing to match against, so the key has nothing to do here: the table
    // starts as this version's contents whatever identifies them.
    await session.run(`CREATE TABLE ${ref} AS SELECT * FROM ${source}`)
  }
  return { snapshotId: await currentSnapshotId(session) }
}

/**
 * What stops this version's key identifying its rows, or null when nothing does
 * (spec §6.6).
 *
 * A fact about the content, not a decision: what to do about one — refuse the
 * version, record why, degrade to a keyless load — belongs with the caller,
 * which is also the only side that can write it down.
 *
 * **Asked of the content, not of the frozen schema.** The columns are the only
 * half a schema could answer; whether the key holds nulls or repeats is a
 * property of the rows, and a composite key's uniqueness is not something the
 * per-column counts recorded at interpretation can be read for.
 *
 * Ordered, because the answers are not independent: a null key column makes the
 * uniqueness count meaningless (`count(DISTINCT)` does not count nulls, so a
 * table of nulls reads as perfectly unique), and a missing column makes both of
 * the others unaskable.
 */
export async function keyFault(
  session: LakeSession,
  opts: { parquetUrl: string; keys: string[] }
): Promise<LakeIngestReason | null> {
  const source = `read_parquet(${sqlLiteral(opts.parquetUrl)})`
  const columns = new Set((await describeColumns(session, source)).map((column) => column.name))
  if (opts.keys.some((key) => !columns.has(key))) return 'key-missing'

  const quoted = opts.keys.map(sqlIdentifier)
  const [row] = await session.rows(
    `SELECT count(*) AS rows,
            count(*) FILTER (WHERE ${quoted.map((k) => `${k} IS NULL`).join(' OR ')}) AS nulls,
            count(DISTINCT (${quoted.join(', ')})) AS distinct_keys
     FROM ${source}`
  )
  if (Number(row.nulls) > 0) return 'key-null'
  return Number(row.distinct_keys) === Number(row.rows) ? null : 'key-not-unique'
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
    // Keyless: §7.2's keyed step-down needs the key both ends share, which is a
    // version-row question this package does not answer (spec §14.1).
    await loadContents(session, ref, source, null)
  } finally {
    await session.run(`DROP TABLE IF EXISTS ${source}`).catch(() => {})
  }
}

/**
 * Put a relation's rows into a table, as one snapshot — the one write path
 * (spec §7.2's three branches).
 *
 * **Columns moved** → replace the table outright: there is nothing to match rows
 * on and nothing to insert into, so neither of the others can be composed. Older
 * snapshots keep the old shape, so time travel to previous versions still works
 * — what the replace costs is the change feed across it, not the history.
 *
 * **A key both ends share** → apply the rows: update what changed, insert what
 * is new, delete what the relation no longer carries. DuckLake takes a single
 * UPDATE/DELETE action per `MERGE`, so the two halves cannot be one statement
 * (spec §11-2.4).
 *
 * **Otherwise** → refill the table, which is every load before ii-b and every
 * resource that never gets a key.
 *
 * One transaction either way, because one version has to be one snapshot: every
 * version-to-version diff resolves through the id recorded against it.
 */
async function loadContents(
  session: LakeSession,
  ref: string,
  source: string,
  key: string[] | null
): Promise<void> {
  const existing = await describeColumns(session, ref)
  const incoming = await describeColumns(session, source)

  if (!sameColumns(existing, incoming)) {
    await session.run(`CREATE OR REPLACE TABLE ${ref} AS SELECT * FROM ${source}`)
    return
  }

  const statements = key
    ? keyedLoadSql({
        table: ref,
        source,
        keys: key,
        values: incoming.map((column) => column.name).filter((name) => !key.includes(name)),
      })
    : [`DELETE FROM ${ref}`, `INSERT INTO ${ref} SELECT * FROM ${source}`]

  await session.run('BEGIN TRANSACTION')
  try {
    for (const statement of statements) await session.run(statement)
    await session.run('COMMIT')
  } catch (err) {
    await session.run('ROLLBACK').catch(() => {})
    throw err
  }
}
