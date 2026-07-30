/**
 * Reclamation against a real DuckLake catalog.
 *
 * `maintenance.test.ts` pins which snapshots get expired; this pins that
 * expiring them actually erases the bytes. That distinction is the whole point
 * of ADR-043 §5 — a purge is a legal deletion, so "no longer referenced" is not
 * the guarantee, "no longer on storage" is — and it is invisible to a fake
 * session, which cannot show that `cleanup_old_files` deletes anything.
 *
 * The catalog is a local DuckDB file and the data path a temp directory, so
 * this needs neither PostgreSQL nor S3 and runs in the unit suite (the same
 * arrangement `diff.test.ts` uses for a plain DuckDB).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { mkdtempSync, rmSync, readdirSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { LakeRow, LakeSession } from '../connection'
import { deleteOrphanedFiles, reclaimUnreferencedSnapshots } from '../maintenance'

let dir: string
let conn: DuckDBConnection
let session: LakeSession

/** The rows a purge is supposed to erase carry this, so a scan can find them. */
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
  it('erases a purged version and leaves the survivors diffable', async () => {
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

  it('has nothing to erase while data inlining is on', async () => {
    // Why `disableDataInlining` exists (ADR-043 §6-1). Inlined rows live in the
    // catalog rather than in Parquet, so reclamation — which only ever deletes
    // files — has nothing to act on, and a purge would report a legal deletion
    // having erased nothing.
    //
    // Asserted as "the table owns no files", which is what makes erasure
    // impossible, rather than by reading DuckLake's internal inlined table:
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
