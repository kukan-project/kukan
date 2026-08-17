/**
 * Reclamation against a real DuckLake catalog.
 *
 * `maintenance.test.ts` pins which snapshots get expired; this pins what that
 * frees on storage, which is invisible to a fake session — it cannot show that
 * `cleanup_old_files` deletes anything.
 *
 * **These cases are ii-a's arithmetic, and ii-a's alone.** A keyless load
 * replaces the whole table, so each version's file is referenced by that
 * version and nothing else, and expiring it frees the file whole. `writeVersion`
 * below is that shape (`DELETE` then `INSERT`). Under ii-b's keyed load a file
 * carries rows from several versions and this stops holding — see
 * `purge.ducklake.test.ts`, where the same arrangement frees nothing, and spec
 * §9, where the purge stops claiming erasure at all. Nothing here is a claim
 * about what a purge guarantees; it is a claim about what reclamation reaches
 * when files and versions line up.
 *
 * The catalog is a local DuckDB file and the data path a temp directory, so
 * this needs neither PostgreSQL nor S3 and runs in the unit suite (the same
 * arrangement `diff.test.ts` uses for a plain DuckDB).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { mkdtempSync, rmSync, readdirSync, copyFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { LakeRow, LakeSession } from '../connection'
import { deleteOrphanedFiles, reclaimUnreferencedSnapshots } from '../maintenance'
import { resolvableSnapshots, rollbackLakeTable } from '../table'

let dir: string
let conn: DuckDBConnection
let session: LakeSession

/** The rows reclamation should free carry this, so a scan can find them. */
const DOOMED = 'PURGE_ME'

async function attach(inlining: boolean) {
  conn = await (await DuckDBInstance.create(':memory:')).connect()
  await conn.run(`INSTALL ducklake`)
  await conn.run(`LOAD ducklake`)
  await conn.run(`ATTACH 'ducklake:${dir}/catalog.ducklake' AS lake (DATA_PATH '${dir}/data/')`)
  if (!inlining) await conn.run(`CALL lake.set_option('data_inlining_row_limit', 0)`)
  session = {
    run: async (sql) => void (await conn.run(sql)),
    rows: async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson() as LakeRow[],
    interrupt: () => conn.interrupt(),
    close: async () => conn.disconnectSync(),
  }
}

const snapshot = async () =>
  Number(
    (await session.rows(`SELECT max(snapshot_id) AS id FROM ducklake_snapshots('lake')`))[0].id
  )

/** One version, written the way Phase ii-a does: replace the whole table. */
async function writeVersion(values: string) {
  await session.run('BEGIN TRANSACTION')
  await session.run(`DELETE FROM lake.t`)
  await session.run(`INSERT INTO lake.t SELECT * FROM (VALUES ${values}) v(id, name)`)
  await session.run('COMMIT')
  return snapshot()
}

/**
 * Rows still readable out of storage — not out of the catalog. Globs the data
 * path rather than the file list so a file the catalog has forgotten but never
 * deleted is still counted, which is exactly the failure being guarded against.
 */
async function doomedRowsOnStorage(): Promise<number> {
  const files = readdirSync(join(dir, 'data'), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.parquet'))
  if (files.length === 0) return 0
  // `union_by_name` lets deletion vectors, whose schema differs, share the scan.
  const rows = await session.rows(
    `SELECT count(*) AS n FROM read_parquet('${dir}/data/**/*.parquet', union_by_name=true)
     WHERE name = '${DOOMED}'`
  )
  return Number(rows[0].n)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kukan-lake-'))
})

afterEach(() => {
  conn?.disconnectSync()
  rmSync(dir, { recursive: true, force: true })
})

describe('reclaimUnreferencedSnapshots — real catalog', () => {
  it('frees a keylessly written version and leaves the survivors diffable', async () => {
    await attach(false)
    await conn.run(`CREATE TABLE lake.t AS SELECT * FROM (VALUES (1, 'a'), (2, 'b')) v(id, name)`)
    const v1 = await snapshot()
    await writeVersion(`(1, 'a'), (2, '${DOOMED}')`)
    const v3 = await writeVersion(`(1, 'a'), (2, 'c')`)
    expect(await doomedRowsOnStorage()).toBe(1)

    // Purge the middle version: v1 and v3 survive, so only they are retained.
    const result = await reclaimUnreferencedSnapshots(session, [v1, v3])

    expect(result.expired).toBeGreaterThan(0)
    expect(await doomedRowsOnStorage()).toBe(0)
    // The retained versions still read, and still diff against each other.
    const diff = await session.rows(
      `SELECT count(*) AS n FROM (SELECT * FROM lake.t AT (VERSION => ${v3})
       EXCEPT ALL SELECT * FROM lake.t AT (VERSION => ${v1}))`
    )
    expect(Number(diff[0].n)).toBe(1)
  })

  it('keeps the live contents when no version is retained', async () => {
    // A purge that dropped the last version rolls the table back first, leaving
    // current contents at a snapshot no version row points at. Expiring that
    // would take the table with it.
    await attach(false)
    await conn.run(`CREATE TABLE lake.t AS SELECT * FROM (VALUES (1, 'a')) v(id, name)`)
    await writeVersion(`(1, 'a'), (2, 'b')`)

    await reclaimUnreferencedSnapshots(session, [])

    const rows = await session.rows(`SELECT count(*) AS n FROM lake.t`)
    expect(Number(rows[0].n)).toBe(2)
  })

  it('has nothing to free while data inlining is on', async () => {
    // Why `disableDataInlining` exists (ADR-043 §6-1). Inlined rows live in the
    // catalog rather than in Parquet, so reclamation — which only ever deletes
    // files — has nothing to act on, and the rows stay reachable to anyone with
    // the catalog even after every snapshot naming them is gone.
    //
    // Asserted as "the table owns no files", which is what puts them out of
    // reclamation's reach, rather than by reading DuckLake's internal inlined table:
    // that name is private and would tie the test to it. A failure here means
    // small writes stopped being inlined, at which point the ADR's note about
    // revisiting this decision applies.
    await attach(true)
    await conn.run(`CREATE TABLE lake.t AS SELECT * FROM (VALUES (1, 'a')) v(id, name)`)
    const v1 = await snapshot()
    await writeVersion(`(1, '${DOOMED}')`)
    const v3 = await writeVersion(`(1, 'c')`)

    await reclaimUnreferencedSnapshots(session, [v1, v3])

    const [info] = await session.rows(
      `SELECT file_count FROM ducklake_table_info('lake') WHERE table_name = 't'`
    )
    expect(Number(info.file_count)).toBe(0)
  })

  it('puts an expired version back onto storage if the inlined rows are flushed', async () => {
    // The other half of why inlining stays off. `flush_inlined_data` reads as
    // the way out — move the rows into Parquet, where reclamation can reach them
    // — and does the opposite: it writes them out **with their history**, so a
    // version whose snapshot was already expired reappears on storage. Neither
    // order helps. Flushing first puts the history in a file every surviving
    // version needs, and expiry then frees nothing.
    //
    // So an inlined row is unreachable and undeleted for good: reclamation only
    // deletes files, and the one call that would make files out of it undoes
    // the deletion. That is the decision, not the file count above.
    await attach(true)
    await conn.run(`CREATE TABLE lake.t AS SELECT * FROM (VALUES (1, '${DOOMED}')) v(id, name)`)
    await writeVersion(`(1, 'clean')`)

    await reclaimUnreferencedSnapshots(session, [])
    expect(await doomedRowsOnStorage()).toBe(0)

    await session.run(`CALL ducklake_flush_inlined_data('lake')`)
    await session.run(`CALL ducklake_cleanup_old_files('lake', cleanup_all => true)`)

    expect(await doomedRowsOnStorage()).toBe(1)
  })
})

describe('DROP TABLE — real catalog', () => {
  it('costs the current contents, not the retained snapshots', async () => {
    // What a purge weighs when no surviving version can be stood on. Dropping is
    // the answer only because the history is not in the table: the versions
    // either side of it still read, and still diff against each other, which is
    // what lets `versionsLakeCanStandOn` stay `active`-only rather than standing
    // the contents back on rows the resource stepped off (spec §9.1).
    await attach(false)
    await conn.run(`CREATE TABLE lake.t AS SELECT * FROM (VALUES (1, 'a')) v(id, name)`)
    const v1 = await snapshot()
    const v2 = await writeVersion(`(1, 'a'), (2, 'b')`)

    await conn.run(`DROP TABLE lake.t`)

    await expect(session.rows(`SELECT count(*) AS n FROM lake.t`)).rejects.toThrow()
    const rows = await session.rows(
      `SELECT (SELECT count(*) FROM lake.t AT (VERSION => ${v1})) AS at1,
              (SELECT count(*) FROM lake.t AT (VERSION => ${v2})) AS at2,
              (SELECT count(*) FROM (SELECT * FROM lake.t AT (VERSION => ${v2})
                 EXCEPT ALL SELECT * FROM lake.t AT (VERSION => ${v1}))) AS diff`
    )
    expect(rows[0]).toMatchObject({ at1: '1', at2: '2', diff: '1' })

    // And the next ingest takes the name back without disturbing them.
    await conn.run(`CREATE TABLE lake.t AS SELECT * FROM (VALUES (9, 'z')) v(id, name)`)
    const after = await session.rows(`SELECT count(*) AS n FROM lake.t AT (VERSION => ${v2})`)
    expect(Number(after[0].n)).toBe(2)
  })
})

describe('resolvableSnapshots — real catalog', () => {
  it('drops an expired snapshot from the set, which is what standing on one costs', async () => {
    // A version row outlives the snapshot it names: expiry is driven by the
    // retained set, and a restore of an older catalog or a reclaim that ran
    // mid-write leaves an id behind (spec §11-5). Callers that pick a table's
    // restore target off those ids have to ask before rolling.
    await attach(false)
    await conn.run(`CREATE TABLE lake.t AS SELECT * FROM (VALUES (1, 'a')) v(id, name)`)
    const v1 = await snapshot()
    const v2 = await writeVersion(`(1, 'a'), (2, 'b')`)

    await reclaimUnreferencedSnapshots(session, [v2])

    expect(await resolvableSnapshots(session, [v1, v2])).toEqual(new Set([v2]))
    // What trusting the recorded id does instead of asking: the roll fails, and
    // for a purge that is a table left holding what it retracted.
    await expect(rollbackLakeTable(session, 't', v1)).rejects.toThrow()
  })
})

describe('deleteOrphanedFiles — real catalog', () => {
  it('deletes an untracked file and leaves the tracked data alone', async () => {
    // DuckLake writes a Parquet before committing it, so a process that dies in
    // between leaves one the catalog has no record of. Nothing else collects
    // those: expiry and cleanup both work from the catalog.
    await attach(false)
    await conn.run(`CREATE TABLE lake.t AS SELECT i AS id, 'v' || i AS name FROM range(100) t(i)`)
    const [tracked] = readdirSync(join(dir, 'data'), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.parquet'))
    copyFileSync(join(dir, 'data', tracked), join(dir, 'data', dirname(tracked), 'orphan.parquet'))

    const deleted = await deleteOrphanedFiles(session, new Date())

    expect(deleted).toHaveLength(1)
    expect(deleted[0]).toContain('orphan.parquet')
    const rows = await session.rows(`SELECT count(*) AS n FROM lake.t`)
    expect(Number(rows[0].n)).toBe(100)
  })

  it('spares a live file whose creating snapshot has been expired', async () => {
    // [ducklake#815](https://github.com/duckdb/ducklake/issues/815): after an
    // expiry, an active file (`end_snapshot IS NULL`) whose `begin_snapshot` was
    // gone got reported as orphaned and deleted — losing live data. Fixed in
    // #863, which was a `DATA_PATH` separator bug rather than a metadata one.
    //
    // Pinned because both halves run here on a schedule — a purge expires, the
    // cron sweeps — and our `DATA_PATH` carries the trailing slash the fix was
    // about. This passes on the version we build against; it is a guard against
    // going backwards, not a live defect.
    await attach(false)
    await conn.run(`CREATE TABLE lake.t AS SELECT i AS id, 'v' || i AS name FROM range(100) t(i)`)
    const created = await snapshot()
    await writeVersion(`(1, 'later')`)
    await session.run(`CALL ducklake_expire_snapshots('lake', versions => [${created}])`)

    const deleted = await deleteOrphanedFiles(session, new Date())

    expect(deleted).toEqual([])
    const rows = await session.rows(`SELECT count(*) AS n FROM lake.t`)
    expect(Number(rows[0].n)).toBe(1)
  })

  it('spares an untracked file younger than the window', async () => {
    // The guard that keeps a write in flight from being read as an orphan.
    await attach(false)
    await conn.run(`CREATE TABLE lake.t AS SELECT i AS id, 'v' || i AS name FROM range(100) t(i)`)
    const [tracked] = readdirSync(join(dir, 'data'), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.parquet'))
    copyFileSync(join(dir, 'data', tracked), join(dir, 'data', dirname(tracked), 'orphan.parquet'))

    const deleted = await deleteOrphanedFiles(session, new Date(Date.now() - 60 * 60 * 1000))

    expect(deleted).toEqual([])
  })

  it('repairs a head whose files are gone from a version whose files remain', async () => {
    // **The restore contract's load-bearing behaviour (spec §11-5).**
    //
    // A table's current head is often a snapshot no version row names —
    // `standOnBase` and a purge standing the table down both leave one. Being
    // unnamed it is what the retained set does not hold, so a later reclaim
    // takes its files. Restore a catalog from before that reclaim and the
    // catalog still names those files: every version row resolves, the head
    // alone does not. Reconciliation finds nothing to null and the sweep, which
    // looks for a null snapshot, never fires — so dropping the table here would
    // lose it for good.
    //
    // The repair is to rewrite the head from a version whose snapshot still
    // resolves. It touches no version row, so write-once holds, and the history
    // survives — which is why the procedure rewrites rather than drops.
    //
    // The missing file is produced by deleting it rather than by restoring a
    // catalog: the end state is the same one cleanup leaves behind (catalog
    // names it, storage does not), and it does not depend on when DuckDB
    // chooses to flush a catalog file.
    await attach(false)
    const parquet = () =>
      readdirSync(join(dir, 'data'), { recursive: true })
        .map(String)
        .filter((f) => f.endsWith('.parquet'))

    await conn.run(`CREATE TABLE lake.t AS SELECT i AS id, 'v1_' || i AS name FROM range(20) t(i)`)
    const named = await snapshot()
    const versionFiles = parquet()

    // Stand the table down onto v1's content, the way `standOnBase` does.
    await conn.run(
      `CREATE OR REPLACE TABLE lake.t AS SELECT * FROM lake.t AT (VERSION => ${named})`
    )
    expect(await snapshot()).toBeGreaterThan(named)
    const headFile = parquet().find((f) => !versionFiles.includes(f))
    expect(headFile).toBeDefined()

    // What a reclaim did while the restored catalog was not looking.
    unlinkSync(join(dir, 'data', headFile!))

    const readable = async (sql: string) => {
      try {
        await session.rows(sql)
        return true
      } catch {
        return false
      }
    }
    // The head is broken and the version is not — the state nothing detects.
    expect(await readable(`SELECT name FROM lake.t`)).toBe(false)
    expect(await readable(`SELECT name FROM lake.t AT (VERSION => ${named})`)).toBe(true)
    // And `count(*)` answers from catalog statistics, so it cannot be the check.
    expect(await readable(`SELECT count(*) FROM lake.t`)).toBe(true)

    await conn.run(
      `CREATE OR REPLACE TABLE lake.t AS SELECT * FROM lake.t AT (VERSION => ${named})`
    )

    const [head] = await session.rows(`SELECT count(*) AS n FROM lake.t WHERE name LIKE 'v1_%'`)
    expect(Number(head.n)).toBe(20)
    const [history] = await session.rows(
      `SELECT count(*) AS n FROM lake.t AT (VERSION => ${named})`
    )
    expect(Number(history.n)).toBe(20)
  })

  it('reports without deleting on a dry run', async () => {
    await attach(false)
    await conn.run(`CREATE TABLE lake.t AS SELECT i AS id, 'v' || i AS name FROM range(100) t(i)`)
    const [tracked] = readdirSync(join(dir, 'data'), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.parquet'))
    const orphan = join(dir, 'data', dirname(tracked), 'orphan.parquet')
    copyFileSync(join(dir, 'data', tracked), orphan)

    const listed = await deleteOrphanedFiles(session, new Date(), true)

    expect(listed).toHaveLength(1)
    expect(existsSync(orphan)).toBe(true)
  })
})
