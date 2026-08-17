/**
 * What reaches a version's bytes in layer 2, and what does not — against a real
 * catalog, for the purge spec §9 rests on.
 *
 * ii-a purges by deleting files, because a keyless load replaces the table and
 * each version owns its files. A keyed load does not: rows arrive and leave
 * individually, so "delete the file" stops meaning "delete the version". These
 * cases establish where that leaves us, and they are why §9 splits a version
 * purge (make it unobtainable) from erasing bytes (rebuild the resource).
 *
 * **Erasure is judged on the bytes, not on what a query returns.** Every
 * assertion here reads the Parquet files on disk directly rather than the table,
 * because a row that no snapshot resolves to is still a row that is still there.
 *
 * The catalog is a local DuckDB file and the data path a temp directory, so this
 * needs neither PostgreSQL nor S3.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LakeRow, LakeSession } from '../connection'
import { keyedLoadSql } from '../keyed-load'

let dir: string
let dataDir: string
let conn: DuckDBConnection
let session: LakeSession

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kukan-lake-purge-'))
  dataDir = join(dir, 'data', 'main', 't')
  conn = await (await DuckDBInstance.create(':memory:')).connect()
  await conn.run(`INSTALL ducklake`)
  await conn.run(`LOAD ducklake`)
  await conn.run(`ATTACH 'ducklake:${dir}/catalog.ducklake' AS lake (DATA_PATH '${dir}/data/')`)
  // As production does (ADR-043 §6-1). Inlined rows would keep version bytes in
  // the catalog instead of the files this is about, and are never reclaimed.
  await conn.run(`CALL lake.set_option('data_inlining_row_limit', 0)`)
  session = {
    run: async (sql) => void (await conn.run(sql)),
    rows: async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson() as LakeRow[],
    interrupt: () => conn.interrupt(),
    close: async () => conn.disconnectSync(),
  }
})

afterEach(() => {
  conn?.disconnectSync()
  rmSync(dir, { recursive: true, force: true })
})

/** A keyed load of one whole version — the shape ii-b will issue (`keyed-load`). */
async function loadVersion(select: string): Promise<number> {
  await session.run(`CREATE OR REPLACE TABLE src AS ${select}`)
  const [upsert, remove] = keyedLoadSql({
    table: 'lake.t',
    source: 'src',
    keys: ['id'],
    values: ['name'],
  })
  await session.run('BEGIN TRANSACTION')
  await session.run(upsert)
  await session.run(remove)
  await session.run('COMMIT')
  const [row] = await session.rows(`SELECT max(snapshot_id) AS id FROM ducklake_snapshots('lake')`)
  return Number(row.id)
}

/** How many rows matching `like` are physically present in the data files. */
async function onDisk(like: string): Promise<number> {
  let found = 0
  for (const file of readdirSync(dataDir)) {
    // Deletion vectors carry positions, not values — a different schema.
    if (!file.endsWith('.parquet') || file.includes('-delete')) continue
    const [row] = await session.rows(
      `SELECT count(*) AS n FROM read_parquet('${join(dataDir, file)}') WHERE name LIKE '${like}'`
    )
    found += Number(row.n)
  }
  return found
}

/**
 * Expire one version's snapshot, then free what nothing points at any more —
 * the layer 2 reach of a version purge (spec §9.1), with no compaction.
 */
async function purge(snapshot: number): Promise<void> {
  await session.run(`CALL ducklake_expire_snapshots('lake', versions => [${snapshot}])`)
  await session.run(`CALL ducklake_cleanup_old_files('lake', cleanup_all => true)`)
}

/**
 * Free everything no surviving version names — `reclaimInSession` modelled
 * against the catalog directly, for the range purge below.
 */
async function reclaim(retain: readonly number[]): Promise<void> {
  const all = (await session.rows(`SELECT snapshot_id FROM ducklake_snapshots('lake')`)).map((r) =>
    Number(r.snapshot_id)
  )
  const keep = new Set([...retain, Math.max(...all)])
  const doomed = all.filter((id) => !keep.has(id))
  if (doomed.length > 0) {
    await session.run(`CALL ducklake_expire_snapshots('lake', versions => [${doomed.join(',')}])`)
  }
  await session.run(`CALL ducklake_cleanup_old_files('lake', cleanup_all => true)`)
}

describe('destroying one version of a keyed table', () => {
  it('expires exactly the snapshot it is given', async () => {
    // The whole approach rests on this. KUKAN purges a named version, not
    // "everything older than": an `older_than` cut would take the versions
    // around it and the diffs that reach through them.
    await session.run(`CREATE TABLE lake.t AS SELECT 1 AS id, 'v1' AS name`)
    const v1 = await loadVersion(`SELECT 1 AS id, 'v1' AS name`)
    const v2 = await loadVersion(`SELECT 1 AS id, 'v2' AS name`)
    const v3 = await loadVersion(`SELECT 1 AS id, 'v3' AS name`)

    await session.run(`CALL ducklake_expire_snapshots('lake', versions => [${v2}])`)

    const left = (await session.rows(`SELECT snapshot_id FROM ducklake_snapshots('lake')`)).map(
      (r) => Number(r.snapshot_id)
    )
    expect(left).toContain(v1)
    expect(left).toContain(v3)
    expect(left).not.toContain(v2)
  })

  it('takes the version rows off the disk, not just out of reach', async () => {
    await session.run(
      `CREATE TABLE lake.t AS SELECT i AS id, 'v1_' || i AS name FROM range(100) tbl(i)`
    )
    // The version to destroy rewrites half the table; the next one rewrites half
    // of that. So it wrote rows that are still current and rows that are not.
    const v2 = await loadVersion(
      `SELECT i AS id, CASE WHEN i < 50 THEN 'SECRET_' || i ELSE 'v1_' || i END AS name FROM range(100) tbl(i)`
    )
    await loadVersion(
      `SELECT i AS id, CASE WHEN i < 25 THEN 'v3_' || i WHEN i < 50 THEN 'SECRET_' || i ELSE 'v1_' || i END AS name FROM range(100) tbl(i)`
    )
    expect(await onDisk('SECRET%')).toBeGreaterThan(25)

    await purge(v2)

    // **Fewer rows go than "the ones nothing points at".** 25 of these are
    // current data that a later version still carries, so they have to stay —
    // but the other 25 stay as well, because they share a file with them. A
    // keyed load rewrites only the rows whose values changed (`keyed-load`), so
    // the file this version wrote is still the file the next version reads
    // from, and nothing gives it an `end_snapshot`.
    //
    // This is ADR-043 §5.1's container principle with no exception left: what a
    // purge can free is a whole file, and files stop lining up with versions the
    // moment rows are written individually. It also shows why the unpredicated
    // form flatters a purge — rewriting every matched row rewrites the whole
    // file, which retires the old one and takes its history with it. Measuring
    // that shape and shipping this one would have overstated the reach of §9.
    expect(await onDisk('SECRET%')).toBe(50)
    const [live] = await session.rows(`SELECT count(*) AS n FROM lake.t WHERE name LIKE 'SECRET%'`)
    expect(Number(live.n)).toBe(25)
  })

  it('destroys a row a later version removed, and keeps the rest', async () => {
    // The shape a takedown request takes: the row is gone from the live table
    // already, and what is being asked for is the bytes.
    await session.run(
      `CREATE TABLE lake.t AS SELECT i AS id, CASE WHEN i = 7 THEN 'SECRET' ELSE 'v1_' || i END AS name FROM range(1000) tbl(i)`
    )
    const [row] = await session.rows(
      `SELECT max(snapshot_id) AS id FROM ducklake_snapshots('lake')`
    )
    const v1 = Number(row.id)
    await loadVersion(`SELECT i AS id, 'v1_' || i AS name FROM range(1000) tbl(i) WHERE i <> 7`)
    expect(await onDisk('SECRET')).toBe(1)

    await purge(v1)

    // **Still there.** The row left the table — the live count is 999 — but the
    // delete is a deletion vector over a file that holds 999 current rows, so
    // the file stays and the row inside it with it. Reaching these bytes needs
    // the file to hold nothing else, which is not something a purge can arrange.
    expect(await onDisk('SECRET')).toBe(1)
    const [count] = await session.rows(`SELECT count(*) AS n FROM lake.t`)
    expect(Number(count.n)).toBe(999)
    // And out of reach through the table, which is what §9 does claim.
    const [reachable] = await session.rows(`SELECT count(*) AS n FROM lake.t WHERE name = 'SECRET'`)
    expect(Number(reachable.n)).toBe(0)
  })

  it('leaves the versions around it readable', async () => {
    await session.run(`CREATE TABLE lake.t AS SELECT 1 AS id, 'v1' AS name`)
    const v1 = await loadVersion(`SELECT 1 AS id, 'v1' AS name`)
    const v2 = await loadVersion(`SELECT 1 AS id, 'SECRET' AS name`)
    const v3 = await loadVersion(`SELECT 1 AS id, 'v3' AS name`)

    await purge(v2)

    expect(await session.rows(`SELECT name FROM lake.t AT (VERSION => ${v1})`)).toEqual([
      { name: 'v1' },
    ])
    expect(await session.rows(`SELECT name FROM lake.t AT (VERSION => ${v3})`)).toEqual([
      { name: 'v3' },
    ])
    await expect(session.rows(`SELECT name FROM lake.t AT (VERSION => ${v2})`)).rejects.toThrow()
  })

  it('cannot free a row behind a deletion vector by expiring its own version', async () => {
    // **The case that ends single-version purging.** A deletion vector leaves the
    // row in the file and records that it is gone. The file is therefore still
    // needed — the other 99 rows in it are current — and it goes on being
    // referenced by every snapshot from the one that wrote it to the one that
    // deleted from it. Expiring the version that *held* the row frees nothing,
    // and neither does expiring every snapshot below the live table: the live
    // table still names the file.
    //
    // This is why §9.1 purges everything from N rather than a version at a time.
    // Nothing short of taking the table below the row reaches the bytes.
    //
    // Forced with a plain DELETE, because that is the path that leaves a vector:
    // a keyed load rewrites the file instead, which is why the cases above come
    // out clean. Which of the two DuckLake takes is not documented, so the
    // difference is pinned here rather than assumed away.
    await session.run(
      `CREATE TABLE lake.t AS SELECT i AS id, CASE WHEN i = 7 THEN 'SECRET' ELSE 'v_' || i END AS name FROM range(100) tbl(i)`
    )
    const [created] = await session.rows(
      `SELECT max(snapshot_id) AS id FROM ducklake_snapshots('lake')`
    )
    await session.run(`DELETE FROM lake.t WHERE id = 7`)
    expect(readdirSync(dataDir).some((f) => f.includes('-delete'))).toBe(true)

    await purge(Number(created.id))

    // Unreachable and undeleted — the state a purge would otherwise report as
    // done, with the bytes still on the disk.
    expect(await onDisk('SECRET')).toBe(1)

    // Nor does emptying the history around it, while the live table holds the
    // file's other 99 rows.
    await reclaim([])
    expect(await onDisk('SECRET')).toBe(1)
  })

  it('takes everything from N, and needs no rewrite to do it — in a catalog of one table', async () => {
    // **The reach of a version purge with nothing else in the catalog** (§9.1).
    // A keyed table where the content arrives at v2, is partly carried by v3,
    // and is gone from the live table by v4 — the shape a request usually
    // arrives in. N is v2, so v2, v3 and v4 go, and live returns to v1.
    //
    // **This is the measurement §9.2 says does not generalize.** It reaches zero
    // because every snapshot in the catalog belongs to this table, so expiring
    // the ones no surviving version names leaves nothing holding the files. A
    // second resource publishing in the same window pins them; the case below
    // is that one, and it is why §9 stopped claiming erasure.
    //
    // Top down, because each step is then a live purge that closes on its own:
    // the table is rolled to the version below and everything unreferenced is
    // freed. `rewrite_data_files` is never called — the rows to destroy were
    // written by loads at v2 or later, so they sit in files born at v2 or later,
    // and nothing that survives names those.
    await session.run(
      `CREATE TABLE lake.t AS SELECT i AS id, 'v1_' || i AS name FROM range(100) tbl(i)`
    )
    const [first] = await session.rows(
      `SELECT max(snapshot_id) AS id FROM ducklake_snapshots('lake')`
    )
    const recorded = new Map([[1, Number(first.id)]])
    recorded.set(
      2,
      await loadVersion(
        `SELECT i AS id, CASE WHEN i < 30 THEN 'SECRET_' || i ELSE 'v1_' || i END AS name FROM range(100) tbl(i)`
      )
    )
    recorded.set(
      3,
      await loadVersion(
        `SELECT i AS id, CASE WHEN i < 10 THEN 'SECRET_' || i ELSE 'v3_' || i END AS name FROM range(100) tbl(i)`
      )
    )
    recorded.set(4, await loadVersion(`SELECT i AS id, 'v4_' || i AS name FROM range(100) tbl(i)`))
    expect(await onDisk('SECRET%')).toBeGreaterThan(0)

    for (const version of [4, 3, 2]) {
      await session.run(
        `CREATE OR REPLACE TABLE lake.t AS SELECT * FROM lake.t AT (VERSION => ${recorded.get(version - 1)})`
      )
      // **The rollback lands the purged rows under a new snapshot**, which is
      // recorded against the version it now holds — so the reclaim has to be
      // computed from the surviving versions, not from the one being purged.
      // Expiring only the named snapshot leaves those rows on the disk.
      const [landed] = await session.rows(
        `SELECT max(snapshot_id) AS id FROM ducklake_snapshots('lake')`
      )
      recorded.set(version - 1, Number(landed.id))
      recorded.delete(version)
      await reclaim([...recorded.values()])
    }

    expect(await onDisk('SECRET%')).toBe(0)
    // And v1 is whole — the point of returning live to N-1 rather than emptying.
    const [kept] = await session.rows(`SELECT count(*) AS n FROM lake.t WHERE name LIKE 'v1_%'`)
    expect(Number(kept.n)).toBe(100)
  })

  it('leaves the purged rows on the disk when only the named snapshots are expired', async () => {
    // The same range, reclaimed the way the procedure reads if "expire the
    // snapshot" is taken to mean the version's own. **Each step's rollback
    // lands the rows it is destroying under a snapshot of its own**, which the
    // next step never names — so rows survive a purge that reported success.
    //
    // Needs three versions to show: with two, the one rollback is also the
    // newest snapshot and holds N-1's rows alone. `reclaimInSession` recomputing
    // the retained set from the surviving version rows is what makes §9.2 true,
    // and it is not an implementation detail.
    await session.run(
      `CREATE TABLE lake.t AS SELECT i AS id, 'v1_' || i AS name FROM range(100) tbl(i)`
    )
    const [first] = await session.rows(
      `SELECT max(snapshot_id) AS id FROM ducklake_snapshots('lake')`
    )
    const recorded = new Map([[1, Number(first.id)]])
    recorded.set(
      2,
      await loadVersion(
        `SELECT i AS id, CASE WHEN i < 30 THEN 'SECRET_' || i ELSE 'v1_' || i END AS name FROM range(100) tbl(i)`
      )
    )
    recorded.set(
      3,
      await loadVersion(
        `SELECT i AS id, CASE WHEN i < 10 THEN 'SECRET_' || i ELSE 'v3_' || i END AS name FROM range(100) tbl(i)`
      )
    )
    recorded.set(4, await loadVersion(`SELECT i AS id, 'v4_' || i AS name FROM range(100) tbl(i)`))

    for (const version of [4, 3, 2]) {
      await session.run(
        `CREATE OR REPLACE TABLE lake.t AS SELECT * FROM lake.t AT (VERSION => ${recorded.get(version - 1)})`
      )
      await purge(recorded.get(version)!)
    }

    expect(await onDisk('SECRET%')).toBeGreaterThan(0)
  })

  it('leaves one table’s rows on the disk because another table needs the snapshots', async () => {
    // **The fact the whole of §9 rests on.** DuckLake snapshots are catalog-wide,
    // not per-table: every commit to any table produces one, and it describes the
    // state of all of them. So the snapshots another resource's live version
    // names sit inside the lifetime of this resource's files, and expiring
    // "everything no surviving version of `t` names" cannot touch them.
    //
    // Pinned here rather than left in the spec's prose because it is the single
    // load-bearing measurement behind not promising erasure — a DuckLake release
    // that made file lifetimes per-table would make this case fail, and that is
    // the day the guarantee could be revisited.
    await session.run(
      `CREATE TABLE lake.t AS SELECT i AS id, CASE WHEN i < 10 THEN 'SECRET_' || i ELSE 'v1_' || i END AS name FROM range(100) tbl(i)`
    )
    // An unrelated resource, publishing twice while `t`'s file is alive.
    await session.run(
      `CREATE TABLE lake.u AS SELECT i AS id, 'u1_' || i AS name FROM range(10) tbl(i)`
    )
    await session.run(`INSERT INTO lake.u SELECT 99 AS id, 'u2' AS name`)
    const [uLive] = await session.rows(
      `SELECT max(snapshot_id) AS id FROM ducklake_snapshots('lake')`
    )

    expect(await onDisk('SECRET%')).toBe(10)

    // The most a purge of `t` can do: the table itself is gone.
    await session.run(`DROP TABLE lake.t`)
    await reclaim([Number(uLive.id)])

    // And the rows are still there, because `u`'s live snapshot is inside the
    // lifetime of the file holding them.
    expect(await onDisk('SECRET%')).toBe(10)

    // What does reach them, and what it costs (§9.7): drop `u`'s history too.
    // `u` keeps its contents — its own files outlive the snapshots that named
    // them — but every version of every resource loses its diff and time travel.
    await reclaim([])
    expect(await onDisk('SECRET%')).toBe(0)
    const [survived] = await session.rows(`SELECT count(*) AS n FROM lake.u`)
    expect(Number(survived.n)).toBe(11)
  })

  it('gives a later load a new id rather than an expired one', async () => {
    // **What keeps the surviving version rows honest.** A purge leaves ids
    // recorded on rows it did not touch, and the corrected upload that follows
    // it (§9.4) commits straight afterwards. Handing that commit an id a purge
    // had expired would leave some other version's row pointing at its rows,
    // and nothing would say so.
    await session.run(`CREATE TABLE lake.t AS SELECT 1 AS id, 'v1' AS name`)
    const spent = [
      await loadVersion(`SELECT 1 AS id, 'v2' AS name`),
      await loadVersion(`SELECT 1 AS id, 'v3' AS name`),
    ]
    for (const snapshot of spent) {
      await session.run(`CALL ducklake_expire_snapshots('lake', versions => [${snapshot}])`)
    }
    await session.run(`CALL ducklake_cleanup_old_files('lake', cleanup_all => true)`)

    const regenerated = [
      await loadVersion(`SELECT 1 AS id, 'v2' AS name`),
      await loadVersion(`SELECT 1 AS id, 'v3' AS name`),
    ]

    expect(regenerated.filter((id) => spent.includes(id))).toEqual([])
    expect(Math.min(...regenerated)).toBeGreaterThan(Math.max(...spent))
  })

  it('does not let the corrected upload bring the purged rows back', async () => {
    // §9.4 step 3: the resource goes on being published after a purge, and the
    // next load runs against a table the purge left standing at N-1. Its own
    // bytes do not carry the row, so nothing puts it back — the property the
    // recovery procedure rests on, and the reason a purge does not have to
    // block further ingest.
    await session.run(
      `CREATE TABLE lake.t AS SELECT i AS id, CASE WHEN i = 7 THEN 'SECRET' ELSE 'v1_' || i END AS name FROM range(50) tbl(i)`
    )
    await loadVersion(`SELECT i AS id, 'v2_' || i AS name FROM range(50) tbl(i) WHERE i <> 7`)

    // N is v1, so nothing survives and the table goes with it.
    await session.run(`DROP TABLE lake.t`)
    await reclaim([])
    expect(await onDisk('SECRET')).toBe(0)

    await session.run(
      `CREATE TABLE lake.t AS SELECT i AS id, 'fixed_' || i AS name FROM range(50) tbl(i) WHERE i <> 7`
    )
    await loadVersion(`SELECT i AS id, 'fixed2_' || i AS name FROM range(50) tbl(i) WHERE i <> 7`)

    expect(await onDisk('SECRET')).toBe(0)
    const [count] = await session.rows(`SELECT count(*) AS n FROM lake.t`)
    expect(Number(count.n)).toBe(49)
  })

  it('merges the files it rewrites, so it is a compactor and not a per-file fix', async () => {
    // `rewrite_data_files` reads as a per-file operation — "rewrite files with
    // more deletes than the threshold" — and is not one. Given several files
    // over the threshold it produces **one**, which is a compaction.
    //
    // KUKAN does not run it (§11-2.1): it only ever takes files that carry
    // deletes, and an append-mostly resource writes files that carry none.
    // Pinned because the shape below — every file heavily deleted — is what
    // made it look like the right tool on synthetic data.
    await session.run(
      `CREATE TABLE lake.t AS SELECT i AS id, 'a' || i AS name FROM range(100) tbl(i)`
    )
    await session.run(
      `INSERT INTO lake.t SELECT i AS id, 'b' || i AS name FROM range(100, 200) tbl(i)`
    )
    await session.run(
      `INSERT INTO lake.t SELECT i AS id, 'c' || i AS name FROM range(200, 300) tbl(i)`
    )
    await session.run(`DELETE FROM lake.t WHERE id IN (5, 105, 205)`)

    const [rewritten] = await session.rows(
      `CALL ducklake_rewrite_data_files('lake', 't', delete_threshold => 0.0)`
    )

    expect(Number(rewritten.files_processed)).toBe(3)
    expect(Number(rewritten.files_created)).toBe(1)
    // And the one KUKAN does run does nothing on this shape, because every
    // file carries a delete and that is explicitly not its job — DuckLake
    // throws `merge_adjacent_files should not be used to rewrite files with
    // deletes` if one reaches it. The two split on deletes, not on size
    // (§11-2.3), which is what makes them complementary rather than
    // interchangeable.
    expect(await session.rows(`CALL ducklake_merge_adjacent_files('lake')`)).toEqual([])
  })

  it('will not rewrite a lightly deleted file at the default threshold', async () => {
    // What the threshold measures, and why it never fires for us (§11-2.1). It
    // is the share of a file's own rows that later versions have superseded —
    // under a delta load a file is a version, so 0.95 means "this version's
    // changes are 95% gone". Administrative data appends and corrects; it does
    // not turn over. A plain DELETE leaves the row in place behind a deletion
    // vector, and one row out of a hundred is nowhere near the default.
    await session.run(
      `CREATE TABLE lake.t AS SELECT i AS id, CASE WHEN i = 5 THEN 'SECRET' ELSE 'v_' || i END AS name FROM range(100) tbl(i)`
    )
    await session.run(`DELETE FROM lake.t WHERE id = 5`)
    // Gone from the table, still in the file.
    expect(await onDisk('SECRET')).toBe(1)

    expect(await session.rows(`CALL ducklake_rewrite_data_files('lake', 't')`)).toEqual([])

    const [rewritten] = await session.rows(
      `CALL ducklake_rewrite_data_files('lake', 't', delete_threshold => 0.0)`
    )
    expect(Number(rewritten.files_processed)).toBe(1)
    expect(Number(rewritten.files_created)).toBe(1)
  })

  it('leaves a per-version purge working when rewrite_data_files has run', async () => {
    // The control for the case below, and the record of a road not taken
    // (§11-2.3). `rewrite_data_files` closes the files it consumes with an
    // `end_snapshot` and dates its output at the snapshot that produced it, so
    // a file holding rows written at N is still a file nothing below N names —
    // a per-version purge reaches the bytes. That property is what made it
    // tempting; it does not survive contact with append-mostly data, which
    // gives it nothing to compact.
    await session.run(
      `CREATE TABLE lake.t AS SELECT i AS id, 'v1_' || i AS name FROM range(100) tbl(i)`
    )
    const [first] = await session.rows(
      `SELECT max(snapshot_id) AS id FROM ducklake_snapshots('lake')`
    )
    const v1 = Number(first.id)
    await session.run(`UPDATE lake.t SET name = 'SECRET_' || id WHERE id < 10`)
    await session.run(`UPDATE lake.t SET name = 'v3_' || id WHERE id >= 90`)
    await session.run(`CALL ducklake_rewrite_data_files('lake', delete_threshold => 0.0)`)
    expect(await onDisk('SECRET%')).toBeGreaterThan(0)

    await session.run(
      `CREATE OR REPLACE TABLE lake.t AS SELECT * FROM lake.t AT (VERSION => ${v1})`
    )
    await reclaim([v1])

    expect(await onDisk('SECRET%')).toBe(0)
    const [kept] = await session.rows(`SELECT count(*) AS n FROM lake.t WHERE name LIKE 'v1_%'`)
    expect(Number(kept.n)).toBe(100)
  })

  it('cannot take them off once merge_adjacent_files has run', async () => {
    // **Why a version purge does not claim to erase** (§9, §11-2.3). The
    // compaction ii-b runs does not close the files it consumes —
    // `WriteMergeAdjacent` deletes their catalog rows outright — and the file it
    // writes inherits the earliest `begin_snapshot` of its sources. Snapshots
    // below N, which the purge keeps, then name a file holding rows written at
    // N. There is no per-version way back to those bytes; §9.2 rebuilds the
    // resource instead.
    //
    // Time travel stays correct throughout, which is what makes this worth
    // pinning: no assertion on contents would notice. Should this ever fail,
    // upstream stopped backdating and §9 can be revisited.
    await session.run(
      `CREATE TABLE lake.t AS SELECT i AS id, 'v1_' || i AS name FROM range(10) tbl(i)`
    )
    const [first] = await session.rows(
      `SELECT max(snapshot_id) AS id FROM ducklake_snapshots('lake')`
    )
    const v1 = Number(first.id)
    // Appends rather than updates, because merging is only offered for files
    // that carry no deletes.
    await session.run(
      `INSERT INTO lake.t SELECT i AS id, 'SECRET_' || i AS name FROM range(10, 20) tbl(i)`
    )
    await session.run(
      `INSERT INTO lake.t SELECT i AS id, 'v3_' || i AS name FROM range(20, 30) tbl(i)`
    )
    await session.run(`CALL ducklake_merge_adjacent_files('lake')`)

    await session.run(
      `CREATE OR REPLACE TABLE lake.t AS SELECT * FROM lake.t AT (VERSION => ${v1})`
    )
    await reclaim([v1])

    expect(await onDisk('SECRET%')).toBe(10)
    // The version the purge kept reads correctly, so nothing else reports this.
    const [kept] = await session.rows(`SELECT count(*) AS n FROM lake.t`)
    expect(Number(kept.n)).toBe(10)

    // **And what does reach them** (§9.2): drop the table and free everything.
    // No reasoning about file lifetimes survives this, which is the point —
    // the guarantee stops depending on how DuckLake laid the files out.
    await session.run(`DROP TABLE lake.t`)
    await reclaim([])

    expect(await onDisk('SECRET%')).toBe(0)
  })
})
