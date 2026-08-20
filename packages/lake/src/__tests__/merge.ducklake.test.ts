/**
 * What DuckLake's `MERGE INTO` actually does, against a real catalog — the
 * spike §14.0 of the versioning-ii spec asks for before ii-b is designed.
 *
 * ii-b tracks changed rows by a declared primary key. A version file is always
 * the resource's **whole** content, so the load-bearing claim is that a keyed
 * load leaves contents that depend on the version's bytes and nothing else —
 * that is what lets a purge rebuild by replaying versions and skip the ones it
 * destroyed. These cases pin the shape that delivers it, and the three places
 * the obvious shape does not.
 *
 * Assertions rather than a note, because every one of them is a statement about
 * someone else's implementation: a DuckLake release can change any of it, and a
 * note would go quietly stale while the design still rested on it.
 *
 * The catalog is a local DuckDB file and the data path a temp directory, so this
 * needs neither PostgreSQL nor S3.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LakeRow, LakeSession } from '../connection'
import { keyedUpsertSql, keyedDeleteSql, type KeyedLoadShape } from '../keyed-load'

let dir: string
let conn: DuckDBConnection
let session: LakeSession

/** v1's rows. v2 changes 1, drops 2, adds 3 — one of every branch. */
const V1 = `SELECT * FROM (VALUES (1,'a'),(2,'b')) v(id, name)`
const V2 = `SELECT * FROM (VALUES (1,'A'),(3,'c')) v(id, name)`

/**
 * From the shared builder, so these assertions describe the statements ii-b will
 * issue. Written out here, they drifted from the adopted form — the value
 * predicate is what makes a five-row change write five rows (spec §11-2.4).
 */
const shape = (table = 'lake.t'): KeyedLoadShape => ({
  table,
  source: 'src',
  keys: ['id'],
  values: ['name'],
})
const UPSERT = keyedUpsertSql(shape())
const DELETE_MISSING = keyedDeleteSql(shape())

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kukan-lake-merge-'))
  conn = await (await DuckDBInstance.create(':memory:')).connect()
  await conn.run(`INSTALL ducklake`)
  await conn.run(`LOAD ducklake`)
  await conn.run(`ATTACH 'ducklake:${dir}/catalog.ducklake' AS lake (DATA_PATH '${dir}/data/')`)
  await conn.run(`CALL lake.set_option('data_inlining_row_limit', 0)`)
  session = {
    run: async (sql) => void (await conn.run(sql)),
    rows: async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson() as LakeRow[],
    interrupt: () => conn.interrupt(),
    close: async () => conn.disconnectSync(),
  }
  await session.run(`CREATE TABLE lake.t AS ${V1}`)
  await session.run(`CREATE TABLE src AS ${V2}`)
})

afterEach(() => {
  conn?.disconnectSync()
  rmSync(dir, { recursive: true, force: true })
})

const contents = (relation = 'lake.t') => session.rows(`SELECT * FROM ${relation} ORDER BY id`)

async function latestSnapshot(): Promise<number> {
  const [row] = await session.rows(`SELECT max(snapshot_id) AS id FROM ducklake_snapshots('lake')`)
  return Number(row.id)
}

describe('MERGE INTO on DuckLake', () => {
  it('refuses an UPDATE and a DELETE in one statement', async () => {
    // The shape the spec assumed — upsert and "delete what the version no longer
    // has" together — is the one DuckLake does not take. Everything below is
    // arranged around this sentence.
    //
    // **When this stops failing, the workaround can go.** A DuckLake release
    // that accepts both actions makes this case fail with "promise resolved
    // instead of rejecting", and that is the signal to collapse the keyed load
    // back to one statement. Three other things come off with it: the
    // transaction that exists only to fold two statements into one snapshot,
    // the distinct-rowid counting anything reading the change feed needs
    // because the second statement reports rows the first one changed (see the
    // two cases below — the diff does not, it compares endpoints), and one of
    // the two delete files each version leaves — object count per version is
    // the cost of history we accept, so halving the tombstones is the one part
    // of it we can get back. Nothing else here would notice; the two-statement
    // cases keep passing either way, which is why the obligation is on this one.
    await expect(
      session.run(`${UPSERT}\n  WHEN NOT MATCHED BY SOURCE THEN DELETE`)
    ).rejects.toThrow(/single UPDATE\/DELETE action/)
  })

  it('takes each half on its own', async () => {
    // INSERT does not count against the limit, so an upsert is one action and
    // the delete is another.
    await session.run(UPSERT)
    expect(await contents()).toEqual([
      { id: 1, name: 'A' },
      // Still here: the upsert has no opinion about rows the version dropped.
      { id: 2, name: 'b' },
      { id: 3, name: 'c' },
    ])

    await session.run(DELETE_MISSING)
    expect(await contents()).toEqual([
      { id: 1, name: 'A' },
      { id: 3, name: 'c' },
    ])
  })

  it('lands both halves as one snapshot when they share a transaction', async () => {
    // A version is one snapshot — the id recorded against it has to reproduce
    // that version's content, and two would leave the first naming a state no
    // version ever had.
    const before = await latestSnapshot()

    await session.run('BEGIN TRANSACTION')
    await session.run(UPSERT)
    await session.run(DELETE_MISSING)
    await session.run('COMMIT')

    expect(await latestSnapshot()).toBe(before + 1)
  })

  it('leaves contents that depend on the version bytes alone', async () => {
    // **The claim ii-b rests on.** A purge rebuilds by replaying versions onto
    // an earlier one; if a keyed load's result depended on what was there
    // before, skipping a destroyed version would land different rows.
    await session.run(`CREATE TABLE lake.u AS SELECT * FROM (VALUES (7,'zzz'),(8,'q')) v(id, name)`)

    for (const table of ['t', 'u']) {
      await session.run('BEGIN TRANSACTION')
      await session.run(keyedUpsertSql(shape(`lake.${table}`)))
      await session.run(keyedDeleteSql(shape(`lake.${table}`)))
      await session.run('COMMIT')
    }

    // `u` never saw v1 and shared no key with it, and still lands on v2 exactly.
    expect(await contents('lake.u')).toEqual(await contents('lake.t'))
    expect(await contents('lake.u')).toEqual([
      { id: 1, name: 'A' },
      { id: 3, name: 'c' },
    ])
  })

  it('stands a keyed table back on an older snapshot from a time-travelled source', async () => {
    // The one operation that moves contents without publishing — a purge coming
    // off the version it retracted — reads the table's own earlier snapshot as
    // its source rather than rebuilding that version's Parquet out of layer 1,
    // which would be a re-interpretation (spec §7.2 decision 3).
    //
    // **This is one of three branches, and the only one that writes a delta.**
    // The two below are what a keyless table and a schema change get, because
    // neither can be expressed as a `MERGE`. Which branch a move takes is
    // decided by the same two questions the ingest asks.
    const v1 = await latestSnapshot()
    await session.run('BEGIN TRANSACTION')
    await session.run(UPSERT)
    await session.run(DELETE_MISSING)
    await session.run('COMMIT')
    const v2 = await latestSnapshot()

    const back = { ...shape(), source: `(SELECT * FROM lake.t AT (VERSION => ${v1}))` }
    await session.run('BEGIN TRANSACTION')
    await session.run(keyedUpsertSql(back))
    await session.run(keyedDeleteSql(back))
    await session.run('COMMIT')

    expect(await contents()).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ])
    // One snapshot, like any other load: the move is a version's worth of
    // writes, not a rewrite of the table.
    expect(await latestSnapshot()).toBe(v2 + 1)
    // And the snapshot it stepped off stays readable, which is what keeps the
    // diffs of the versions it passes over available (spec §9.1).
    expect(await session.rows(`SELECT * FROM lake.t AT (VERSION => ${v2}) ORDER BY id`)).toEqual([
      { id: 1, name: 'A' },
      { id: 3, name: 'c' },
    ])
  })

  it('stands a keyless table back with DELETE and INSERT in one transaction', async () => {
    // A version with no declared key — every version before ii-b, and every
    // resource that never gets one — has nothing to match rows on, so the move
    // takes the shape ii-a's ingest already uses. Still one snapshot, still no
    // `CREATE OR REPLACE`: what it gives up is only the delta, since every row
    // is rewritten.
    const v1 = await latestSnapshot()
    await session.run('BEGIN TRANSACTION')
    await session.run(UPSERT)
    await session.run(DELETE_MISSING)
    await session.run('COMMIT')
    const v2 = await latestSnapshot()

    await session.run('BEGIN TRANSACTION')
    await session.run(`DELETE FROM lake.t`)
    await session.run(`INSERT INTO lake.t SELECT * FROM lake.t AT (VERSION => ${v1})`)
    await session.run('COMMIT')

    expect(await contents()).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ])
    expect(await latestSnapshot()).toBe(v2 + 1)
    // Time travel to either end still answers afterwards.
    expect(await session.rows(`SELECT * FROM lake.t AT (VERSION => ${v2}) ORDER BY id`)).toEqual([
      { id: 1, name: 'A' },
      { id: 3, name: 'c' },
    ])
    // **And it only works because the write in between replaced the contents.**
    // The case below is the same statements over a table whose head still holds
    // the target's files.
  })

  it('empties the table when the DELETE and the time travel share files', async () => {
    // 🔴 **The trap under the branch above.** Inside the transaction, `DELETE`
    // takes the time-travel read of the same table with it: `t AT (VERSION => n)`
    // answers **zero rows** once the files that snapshot resolves through are the
    // ones just deleted, so the `INSERT` writes nothing and the move empties the
    // table. No error, and the contents are gone.
    //
    // Sharing is what decides it. ii-a's loads replace the contents wholesale,
    // so the head's files and an earlier version's are disjoint and the case
    // above passes. **A keyed load updates in place, so ii-b always shares** —
    // which is why `restandLakeTable` reads the snapshot out into a temp table
    // before it deletes anything, rather than relying on the branch above.
    const v1 = await latestSnapshot()
    // An append, so v1's file is still part of the current contents.
    await session.run(`INSERT INTO lake.t SELECT * FROM (VALUES (3, 'c')) v(id, name)`)

    await session.run('BEGIN TRANSACTION')
    await session.run(`DELETE FROM lake.t`)
    await session.run(`INSERT INTO lake.t SELECT * FROM lake.t AT (VERSION => ${v1})`)
    await session.run('COMMIT')

    expect(await contents()).toEqual([])
    // Reading it out first is the whole difference: same target, same statements.
    await session.run(
      `CREATE OR REPLACE TEMP TABLE src2 AS SELECT * FROM lake.t AT (VERSION => ${v1})`
    )
    await session.run('BEGIN TRANSACTION')
    await session.run(`DELETE FROM lake.t`)
    await session.run(`INSERT INTO lake.t SELECT * FROM src2`)
    await session.run('COMMIT')

    expect(await contents()).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ])
  })

  it('needs a whole-table replace when the columns moved', async () => {
    // The third branch, and the one the spec's "never `CREATE OR REPLACE`" was
    // too strong for: across a column change there is nothing to match rows on
    // *and* nothing to insert into, so neither of the two above can be
    // composed. `INSERT` fails rather than silently doing something else, which
    // is what makes the branch decidable from the column lists alone.
    const v1 = await latestSnapshot()
    await session.run(`ALTER TABLE lake.t ADD COLUMN note VARCHAR`)
    await session.run(`UPDATE lake.t SET note = 'n' || id`)
    const v2 = await latestSnapshot()

    await expect(
      session.run(`INSERT INTO lake.t SELECT * FROM lake.t AT (VERSION => ${v1})`)
    ).rejects.toThrow()

    await session.run(
      `CREATE OR REPLACE TABLE lake.t AS SELECT * FROM lake.t AT (VERSION => ${v1})`
    )
    expect(await contents()).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ])
    // Time travel across the replace still answers, which is what keeps the
    // diffs either side of it available — the change feed is what the replace
    // costs (spec §14.0), not the history.
    expect(await session.rows(`SELECT * FROM lake.t AT (VERSION => ${v2}) ORDER BY id`)).toEqual([
      { id: 1, name: 'a', note: 'n1' },
      { id: 2, name: 'b', note: 'n2' },
    ])
  })

  it('reports a keyed change as a preimage/postimage pair', async () => {
    // What the row-level diff needs and the keyless ii-a cannot give: a changed
    // row read as one change rather than as an add and a remove.
    const from = await latestSnapshot()
    await session.run(UPSERT)
    const to = await latestSnapshot()

    const changes = await session.rows(
      `SELECT change_type, id, name FROM ducklake_table_changes('lake', 'main', 't', ${to}, ${to})
       ORDER BY change_type, id`
    )

    expect(changes).toEqual([
      { change_type: 'insert', id: 3, name: 'c' },
      { change_type: 'update_postimage', id: 1, name: 'A' },
      { change_type: 'update_preimage', id: 1, name: 'a' },
    ])
    expect(to).toBe(from + 1)
  })

  it('repeats the changed row once per statement that touched its file', async () => {
    // The cost of needing two statements: the delete half rewrites the file the
    // upsert just wrote, and the row it did not touch is reported again. Reading
    // these as rows counts one change twice, so anything reading the change feed
    // has to count distinct rowids.
    //
    // **The diff is not one of those readers** (spec §7). It compares both
    // endpoints under `AT (VERSION => …)`, where a repeated report has nothing to
    // repeat — the two cases below are why counting events cannot answer a diff
    // at all, and this one is why counting them needs care even so. What still
    // reads the feed is ingest verification.
    //
    // Reported as [ducklake#1387](https://github.com/duckdb/ducklake/issues/1387).
    // Failing here means the repetition is gone — either because DuckLake stopped
    // reporting it or because the load became one statement.
    await session.run('BEGIN TRANSACTION')
    await session.run(UPSERT)
    await session.run(DELETE_MISSING)
    await session.run('COMMIT')
    const at = await latestSnapshot()

    const changes = (await session.rows(
      `SELECT change_type, rowid, id FROM ducklake_table_changes('lake', 'main', 't', ${at}, ${at})`
    )) as { change_type: string; rowid: string; id: number }[]

    const postimages = changes.filter((c) => c.change_type === 'update_postimage')
    expect(postimages.length).toBeGreaterThan(1)
    expect(new Set(postimages.map((c) => String(c.rowid))).size).toBe(1)
  })

  it('accepts a source whose key repeats, and keeps one row of each', async () => {
    // Silently — so a resource whose declared key is not unique would lose rows
    // with no error to catch. ii-b has to check before it merges; the check is
    // one aggregate, cheap enough to run on every keyed load.
    //
    // **When this stops passing, the check still stays.** duckdb/duckdb#24058
    // (merged after v1.5.5, so not in a release yet) makes a WHEN MATCHED action
    // that would touch one target row twice raise "cannot affect the same target
    // row more than once", and this case will start throwing. What that changes
    // is the reason for checking, not whether to: the merge refusing gives a
    // failure the ingest has to catch and record as `key-not-unique` (§6.6),
    // where today the check is the only thing standing between a duplicated key
    // and silent row loss. **Not a keyless fallback** — §6.4 refuses to ingest
    // the version rather than mixing one whole-table replacement into a keyed
    // history, which would draw as "every row changed". The case below is why
    // the check cannot go either way.
    await session.run(
      `CREATE OR REPLACE TABLE src AS SELECT * FROM (VALUES (1,'x'),(1,'y')) v(id, name)`
    )

    const [counts] = await session.rows(
      `SELECT count(*) AS rows, count(DISTINCT id) AS keys FROM src`
    )
    expect(Number(counts.rows)).toBe(2)
    expect(Number(counts.keys)).toBe(1)

    await session.run(UPSERT)

    // One of the two won, and nothing said which or that it happened.
    expect(await contents()).toEqual([
      { id: 1, name: expect.stringMatching(/^[xy]$/) },
      { id: 2, name: 'b' },
    ])
  })

  it('inserts a repeated key the table does not have twice over', async () => {
    // The half no cardinality rule reaches: duckdb/duckdb#24058 leaves
    // `WHEN NOT MATCHED` alone, and these rows never match anything. So the
    // fix that makes the case above throw leaves this one silent, and the key
    // the resource declared stops being a key **inside the table**.
    //
    // That is self-perpetuating: the next version's merge then matches one
    // source row against two target rows, updates both, and the row-level diff
    // is wrong from there on. Checking the source before merging is the only
    // place this can be stopped, which is why it belongs on every keyed load
    // rather than behind a setting.
    await session.run(
      `CREATE OR REPLACE TABLE src AS SELECT * FROM (VALUES (5,'x'),(5,'y')) v(id, name)`
    )

    await session.run(UPSERT)

    expect(await session.rows(`SELECT * FROM lake.t WHERE id = 5 ORDER BY name`)).toEqual([
      { id: 5, name: 'x' },
      { id: 5, name: 'y' },
    ])
    const [after] = await session.rows(
      `SELECT count(*) AS rows, count(DISTINCT id) AS keys FROM lake.t`
    )
    expect(Number(after.rows)).toBeGreaterThan(Number(after.keys))
  })

  it('matches on a key of several columns', async () => {
    // §6.4 lets an administrator name more than one column, and both halves take
    // it — the `ON` is the only thing that changes.
    await session.run(
      `CREATE TABLE lake.c AS SELECT * FROM (VALUES ('jp',1,'a'),('us',1,'b')) v(cc, id, name)`
    )
    await session.run(
      `CREATE OR REPLACE TABLE src AS SELECT * FROM (VALUES ('jp',1,'A'),('jp',2,'c')) v(cc, id, name)`
    )
    const on = `ON t.cc = s.cc AND t.id = s.id`

    await session.run(`MERGE INTO lake.c AS t USING src AS s ${on}
      WHEN MATCHED THEN UPDATE SET name = s.name
      WHEN NOT MATCHED THEN INSERT VALUES (s.cc, s.id, s.name)`)
    await session.run(`MERGE INTO lake.c AS t USING src AS s ${on}
      WHEN NOT MATCHED BY SOURCE THEN DELETE`)

    // ('us',1) shares `id` with a source row and still goes, because the pair
    // is what identifies a row.
    expect(await session.rows(`SELECT * FROM lake.c ORDER BY cc, id`)).toEqual([
      { cc: 'jp', id: 1, name: 'A' },
      { cc: 'jp', id: 2, name: 'c' },
    ])
  })

  it('will not count a composite key with count(DISTINCT a, b)', async () => {
    // The duplicate check has to be written for the composite case from the
    // start: the obvious spelling is a binder error, not a wrong answer, so it
    // would be found — but only once someone names two columns.
    await session.run(
      `CREATE OR REPLACE TABLE src AS SELECT * FROM (VALUES ('jp',1),('jp',1),('us',1)) v(cc, id)`
    )

    await expect(session.rows(`SELECT count(DISTINCT cc, id) FROM src`)).rejects.toThrow(
      /No function matches/
    )

    // Either of these works. The row constructor keeps it one scan.
    const [byRow] = await session.rows(
      `SELECT count(*) AS rows, count(DISTINCT (cc, id)) AS keys FROM src`
    )
    expect([Number(byRow.rows), Number(byRow.keys)]).toEqual([3, 2])
  })

  it('never matches a NULL key, and quietly grows a row per version', async () => {
    // `ON t.id = s.id` is `=`, and NULL is not equal to NULL. The source row
    // does not match the target row that looks identical, so it is inserted —
    // every version, forever.
    //
    // **The duplicate check does not catch this on its own.** `count(DISTINCT)`
    // ignores NULLs, so a source with one NULL key reads as one key short and
    // trips the check by accident rather than on purpose. ii-b has to refuse a
    // key column that is nullable in its own right — `IS NOT DISTINCT FROM`
    // would make the join match, but "two unknowns are the same row" is a claim
    // about the data nobody has made.
    await session.run(
      `CREATE TABLE lake.n AS SELECT * FROM (VALUES (NULL,'a'),(2,'b')) v(id, name)`
    )
    await session.run(
      `CREATE OR REPLACE TABLE src AS SELECT * FROM (VALUES (NULL,'A'),(2,'B')) v(id, name)`
    )

    await session.run(`MERGE INTO lake.n AS t USING src AS s ON t.id = s.id
      WHEN MATCHED THEN UPDATE SET name = s.name
      WHEN NOT MATCHED THEN INSERT VALUES (s.id, s.name)`)

    // Two NULL-keyed rows where the version described one.
    expect(await session.rows(`SELECT name FROM lake.n WHERE id IS NULL ORDER BY name`)).toEqual([
      { name: 'A' },
      { name: 'a' },
    ])
  })

  it('still time travels through a table carrying delete vectors', async () => {
    // The purge's reclaim and every diff resolve versions with `AT (VERSION => …)`.
    // A keyed load deletes rows rather than replacing files, so this is the first
    // time that has to hold over a table with deletes in it.
    const v1At = await latestSnapshot()
    await session.run('BEGIN TRANSACTION')
    await session.run(UPSERT)
    await session.run(DELETE_MISSING)
    await session.run('COMMIT')
    const v2At = await latestSnapshot()

    expect(await contents(`lake.t AT (VERSION => ${v1At})`)).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ])
    expect(await contents(`lake.t AT (VERSION => ${v2At})`)).toEqual([
      { id: 1, name: 'A' },
      { id: 3, name: 'c' },
    ])
  })

  it('reports changes that cancel, where the endpoints say nothing moved', async () => {
    // **Why the diff compares endpoints rather than reading the change feed**
    // (spec §7). `table_changes` is a log of what happened, and the diff is
    // asked what differs — over a range of versions those are not the same
    // question. A row that changes and changes back, or is added and then
    // removed, leaves both events in the log and no difference at the ends.
    //
    // `DISTINCT rowid` does not rescue it: that is the deduplication
    // ducklake#1387 needs for one snapshot's repeated reports, and it is
    // applied below. Cancelling events are distinct rows legitimately.
    const load = async (values: string) => {
      await session.run(
        `CREATE OR REPLACE TABLE src AS SELECT * FROM (VALUES ${values}) v(id, name)`
      )
      await session.run('BEGIN TRANSACTION')
      await session.run(UPSERT)
      await session.run(DELETE_MISSING)
      await session.run('COMMIT')
      return latestSnapshot()
    }
    // v1 is already `lake.t`. Change a row and add one, then undo both.
    const v1 = await latestSnapshot()
    await load(`(1,'b'),(2,'b'),(9,'x')`)
    const v3 = await load(`(1,'a'),(2,'b')`)

    // The ends are identical.
    expect(await contents(`lake.t AT (VERSION => ${v3})`)).toEqual(
      await contents(`lake.t AT (VERSION => ${v1})`)
    )

    const events = await session.rows(
      `SELECT change_type, count(DISTINCT rowid) AS n
         FROM ducklake_table_changes('lake', 'main', 't', ${v1}, ${v3})
        GROUP BY change_type ORDER BY change_type`
    )
    // Every kind of change, over a range where nothing changed.
    expect(events.map((e) => e.change_type)).toEqual([
      'delete',
      'insert',
      'update_postimage',
      'update_preimage',
    ])

    // The endpoint comparison — ii-a's `buildDiffQuery` in miniature, grouping
    // by the declared key instead of the whole row — agrees with the table.
    const [net] = await session.rows(`
      SELECT count(*) FILTER (WHERE a.id IS NULL) AS added,
             count(*) FILTER (WHERE b.id IS NULL) AS removed,
             count(*) FILTER (WHERE a.id IS NOT NULL AND b.id IS NOT NULL
                              AND a.name IS DISTINCT FROM b.name) AS changed
        FROM (SELECT * FROM lake.t AT (VERSION => ${v1})) a
        FULL OUTER JOIN (SELECT * FROM lake.t AT (VERSION => ${v3})) b ON a.id = b.id`)
    expect(net).toEqual({ added: '0', removed: '0', changed: '0' })
  })

  it('counts the starting snapshot as part of the range', async () => {
    // The second reason the change feed cannot answer a diff, and the one that
    // reaches the default: `table_changes(from, to)` includes what `from` itself
    // wrote, so even adjacent versions come out wrong. Nothing about the API
    // says which end is exclusive, which is why this is pinned rather than
    // remembered.
    const v1 = await latestSnapshot()
    await session.run('BEGIN TRANSACTION')
    await session.run(UPSERT)
    await session.run(DELETE_MISSING)
    await session.run('COMMIT')
    const v2 = await latestSnapshot()

    const at = async (from: number) =>
      (
        await session.rows(
          `SELECT DISTINCT snapshot_id FROM ducklake_table_changes('lake', 'main', 't', ${from}, ${v2})
          ORDER BY snapshot_id`
        )
      ).map((r) => Number(r.snapshot_id))

    // v1 created the table; asking for the diff since v1 replays that creation.
    expect(await at(v1)).toEqual([v1, v2])
    expect(await at(v1 + 1)).toEqual([v2])
  })

  it('takes a table whose every column is part of the key', async () => {
    // A one-column list of identifiers is a legitimate resource, and there is
    // then nothing for an update to carry. The generated upsert leaves the
    // update branch out — spelling it would be `WHEN MATCHED AND () THEN
    // UPDATE SET`, a parse error — and rows can only be added or removed.
    const allKey: KeyedLoadShape = { table: 'lake.k', source: 'src', keys: ['id'], values: [] }
    expect(keyedUpsertSql(allKey)).not.toContain('WHEN MATCHED')

    await session.run(`CREATE TABLE lake.k AS SELECT * FROM (VALUES (1),(2)) v(id)`)
    await session.run(`CREATE OR REPLACE TABLE src AS SELECT * FROM (VALUES (2),(3)) v(id)`)

    await session.run('BEGIN TRANSACTION')
    await session.run(keyedUpsertSql(allKey))
    await session.run(keyedDeleteSql(allKey))
    await session.run('COMMIT')

    expect(await session.rows(`SELECT * FROM lake.k ORDER BY id`)).toEqual([{ id: 2 }, { id: 3 }])
  })

  it('writes a whole file or a delta according to the predicate on WHEN MATCHED', async () => {
    // **Why the keyed load carries a value predicate (§11-2.4).**
    // `WHEN MATCHED THEN UPDATE` has none, so every matched row is updated —
    // including the 9,995 whose value is unchanged — and replacing the file is
    // then the right thing to do. Add `AND t.name IS DISTINCT FROM s.name` and
    // the same load writes only what moved. `UPDATE` behaves identically: what
    // decides the write path is how many rows the statement updates, not which
    // statement it is.
    //
    // Deltas cut storage by two orders of magnitude, and that is why they are
    // adopted. What they cost is reclamation's reach: one file then serves
    // several versions, mixing rows a purge would like to free with rows the
    // live table still needs, so expiring the range does not free it and
    // neither does a rewrite at threshold zero. **That cost is accepted rather
    // than paid** — a purge claims a version is unobtainable, not that its
    // bytes are gone (spec §9), and the catalog-wide sharing in
    // `purge.ducklake.test.ts` means the whole-file form would not have bought
    // erasure either.
    //
    // A release that made the unconditional form write deltas would flip the
    // measurement this case exists to hold. This is where it would show up.
    // Counted from the catalog rather than the data path: a listing of the
    // directory races with DuckLake's own writes when the suite runs under
    // load, and the claim here is about what the catalog decided anyway.
    const table = async (name: string) => {
      const [info] = await session.rows(
        `SELECT file_count, delete_file_count FROM ducklake_table_info('lake') WHERE table_name = '${name}'`
      )
      return { live: Number(info.file_count), deletes: Number(info.delete_file_count) }
    }
    const load = async (name: string, matched: string) => {
      await session.run(
        `CREATE TABLE lake.${name} AS SELECT i AS id, 'v1_' || i AS name FROM range(10000) tbl(i)`
      )
      await session.run(`CREATE OR REPLACE TABLE ${name}src AS SELECT i AS id,
         CASE WHEN i < 5 THEN 'CHANGED_' || i ELSE 'v1_' || i END AS name FROM range(10000) tbl(i)`)
      await session.run(`MERGE INTO lake.${name} AS t USING ${name}src AS s ON t.id = s.id
        ${matched}
        WHEN NOT MATCHED THEN INSERT VALUES (s.id, s.name)`)
    }

    await load('whole', `WHEN MATCHED THEN UPDATE SET name = s.name`)
    // One live file and no tombstone: the merge replaced the table wholesale.
    expect(await table('whole')).toEqual({ live: 1, deletes: 0 })

    await load(
      'delta',
      `WHEN MATCHED AND t.name IS DISTINCT FROM s.name THEN UPDATE SET name = s.name`
    )
    // The original alongside what moved, and a tombstone for what it replaced.
    expect(await table('delta')).toEqual({ live: 2, deletes: 1 })

    // Same answer either way — only the storage differs.
    expect(await contents('lake.delta')).toEqual(await contents('lake.whole'))
  })
})
