/**
 * DuckLake loads (ADR-043 layer 2 / Phase ii-a).
 *
 * A version's ingest puts contents into a table through {@link loadContents},
 * reading the Parquet the Interpret step produced (the types were inferred once
 * there, ADR-029, and are reused rather than re-parsed from CSV).
 *
 * **Given a key both ends share, the load applies rows rather than replacing
 * them** (ii-b): update what changed, insert what is new, delete what the
 * version no longer carries. Without one — no key, or contents identified some
 * other way — it replaces them wholesale, which DuckLake's copy-on-write still
 * keeps to roughly the delta. Which of the two is not this package's decision to
 * make: it rests on what a version row says (spec §7.2), and the caller resolves
 * it before calling.
 */
import type { KeyFault } from '@kukan/shared'
import { describeColumns, sameColumns } from './columns'
import type { BucketSession, LakeSession } from './connection'
import { keyedLoadSql } from './keyed-load'
import { sqlIdentifier, sqlLiteral } from './sql'
import { currentSnapshotId, lakeTableExists, lakeTableRef } from './table'

export interface IngestResult {
  /** Snapshot to record on the version; reading it reproduces this content. */
  snapshotId: number
}

/**
 * Ingest one version's Parquet into its DuckLake table.
 *
 * The caller must be the catalog's only writer — a resource's own catalog,
 * written under its claim (ADR-067): the snapshot id is read back as the
 * catalog's maximum, which only identifies this commit while nothing else
 * writes it.
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
     * package does not read. The diff's first stage asks the same question of
     * the same two lists.
     */
    key?: string[] | null
  }
): Promise<IngestResult> {
  const ref = lakeTableRef(session, opts.table)
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
  session: BucketSession,
  opts: { parquetUrl: string; keys: string[] }
): Promise<KeyFault | null> {
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
