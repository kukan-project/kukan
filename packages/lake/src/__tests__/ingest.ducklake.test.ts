/**
 * Ingest against a real DuckLake catalog, for the claim the ii-a diff rests on.
 *
 * When a version's columns differ from the table's, `ingestParquetVersion`
 * replaces the table outright, and the comment there asserts that older
 * snapshots keep their shape so time travel still works. Nothing exercised
 * that. If it does not hold, what breaks is not an edge case — it is **every
 * diff that spans a schema change**, and it breaks quietly: `diffVersions`
 * resolves both sides with `AT (VERSION => …)`, so a lost snapshot surfaces as
 * an error or an empty answer rather than a wrong one.
 *
 * The catalog is a local DuckDB file and the data path a temp directory, so this
 * needs neither PostgreSQL nor S3 (the arrangement `maintenance.ducklake.test.ts`
 * uses).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LakeRow, LakeSession } from '../connection'
import { ingestParquetVersion, keyFault, restandLakeTable } from '../ingest'
import { diffVersions } from '../diff'
import { describeColumns } from '../columns'
import { currentSnapshotId } from '../table'

let dir: string
let conn: DuckDBConnection
let session: LakeSession

const TABLE = 'res_x'

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kukan-lake-ingest-'))
  conn = await (await DuckDBInstance.create(':memory:')).connect()
  await conn.run(`INSTALL ducklake`)
  await conn.run(`LOAD ducklake`)
  await conn.run(`ATTACH 'ducklake:${dir}/catalog.ducklake' AS lake (DATA_PATH '${dir}/data/')`)
  // As production does (ADR-043 §6-1): inlined rows would keep the versions'
  // bytes in the catalog instead of the files this is about.
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

/**
 * One version's interpreted table, written to Parquet the way Interpret hands
 * it over (ADR-046) — a local file the ingest reads with `read_parquet`.
 */
async function version(name: string, select: string): Promise<string> {
  const path = join(dir, `${name}.parquet`)
  await conn.run(`COPY (${select}) TO '${path}' (FORMAT PARQUET)`)
  return path
}

const ingest = (parquetUrl: string) => ingestParquetVersion(session, { table: TABLE, parquetUrl })

/** Where a move landed, which nothing records for it (spec §7.2). */
const latestSnapshot = () => currentSnapshotId(session)

describe('ingestParquetVersion — a version whose columns moved', () => {
  it('keeps earlier snapshots readable at their own shape', async () => {
    const v1 = await ingest(await version('v1', `SELECT 1 AS id, 'a' AS name`))
    // A column appears, so the ingest replaces the table rather than refilling it.
    const v2 = await ingest(
      await version('v2', `SELECT 1 AS id, 'a' AS name, 'x' AS note UNION ALL SELECT 2, 'b', 'y'`)
    )

    const at = (snapshot: number) => `lake.${TABLE} AT (VERSION => ${snapshot})`

    // The table as it stands is v2's.
    expect((await describeColumns(session, at(v2.snapshotId))).map((c) => c.name)).toEqual([
      'id',
      'name',
      'note',
    ])
    // And v1's snapshot still answers with v1's columns and v1's row — the
    // claim the replace branch makes.
    expect((await describeColumns(session, at(v1.snapshotId))).map((c) => c.name)).toEqual([
      'id',
      'name',
    ])
    expect(await session.rows(`SELECT * FROM ${at(v1.snapshotId)} ORDER BY id`)).toEqual([
      { id: 1, name: 'a' },
    ])
  })

  it('is reported as a schema change rather than as rows moving', async () => {
    const v1 = await ingest(await version('v1', `SELECT 1 AS id, 'a' AS name`))
    const v2 = await ingest(await version('v2', `SELECT 1 AS id, 'a' AS name, 'x' AS note`))

    const diff = await diffVersions(session, {
      table: TABLE,
      fromSnapshot: v1.snapshotId,
      toSnapshot: v2.snapshotId,
    })

    expect(diff.schemaChanged).toBe(true)
    if (!diff.schemaChanged) return
    expect(diff.schemaDiff.added.map((c) => c.name)).toEqual(['note'])
    expect(diff.schemaDiff.removed).toEqual([])
  })

  it('still diffs rows across a version that only replaced the contents', async () => {
    // The shapes match, so this takes the DELETE + INSERT branch. Kept next to
    // the replace cases because the two have to stay distinguishable: a replace
    // that silently became a refill would make the case above pass for the
    // wrong reason.
    const v1 = await ingest(await version('v1', `SELECT 1 AS id, 'a' AS name`))
    const v2 = await ingest(
      await version('v2', `SELECT 1 AS id, 'a' AS name UNION ALL SELECT 2, 'b'`)
    )

    const diff = await diffVersions(session, {
      table: TABLE,
      fromSnapshot: v1.snapshotId,
      toSnapshot: v2.snapshotId,
    })

    expect(diff).toMatchObject({ schemaChanged: false, addedRows: 1, removedRows: 0 })
  })
})

describe('a keyed version load', () => {
  /** `key` is what both ends share, which the caller resolves (spec §7.2). */
  const keyed = (parquetUrl: string, key: string[] | null) =>
    ingestParquetVersion(session, { table: TABLE, parquetUrl, key })

  it('writes the rows that moved and leaves the rest alone', async () => {
    // What ii-b buys over replacing the contents: the version's own rows are
    // what the diff reads, and the files the load writes are the delta rather
    // than the table (spec §11-2.4).
    const v1 = await keyed(
      await version('v1', `SELECT * FROM (VALUES (1,'a'),(2,'b')) v(id, name)`),
      null
    )
    const v2 = await keyed(
      await version('v2', `SELECT * FROM (VALUES (1,'A'),(3,'c')) v(id, name)`),
      ['id']
    )

    expect(await session.rows(`SELECT * FROM lake.${TABLE} ORDER BY id`)).toEqual([
      { id: 1, name: 'A' },
      { id: 3, name: 'c' },
    ])
    // One version, one snapshot: two statements inside one transaction, which
    // is what every version-to-version diff resolves through.
    expect(v2.snapshotId).toBe(v1.snapshotId + 1)
    // And the version it stepped over still reads as itself.
    expect(
      await session.rows(`SELECT * FROM lake.${TABLE} AT (VERSION => ${v1.snapshotId}) ORDER BY id`)
    ).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ])
  })

  it('replaces the contents when the base was loaded under another key', async () => {
    // The uniqueness of a key is checked on the incoming version alone, so
    // under any other key the contents may hold duplicates of it — where
    // `MERGE` drops a row without saying so (spec §6.6, §7.2).
    await keyed(await version('v1', `SELECT * FROM (VALUES (1,'a'),(2,'a')) v(id, name)`), null)

    // The caller resolved "no shared key" — the base is identified by `id` and
    // the version by `name`.
    await keyed(await version('v2', `SELECT * FROM (VALUES (9,'a')) v(id, name)`), null)

    // Replaced, not merged onto the two rows that share `name`.
    expect(await session.rows(`SELECT * FROM lake.${TABLE} ORDER BY id`)).toEqual([
      { id: 9, name: 'a' },
    ])
  })

  it('replaces the contents when the columns moved under it', async () => {
    await keyed(await version('v1', `SELECT 1 AS id, 'a' AS name`), null)

    await keyed(await version('v2', `SELECT 1 AS id, 'a' AS name, 'x' AS note`), ['id'])

    expect(await session.rows(`SELECT * FROM lake.${TABLE}`)).toEqual([
      { id: 1, name: 'a', note: 'x' },
    ])
  })
})

describe('keyFault', () => {
  const refusal = async (select: string, keys: string[]) =>
    keyFault(session, { parquetUrl: await version('v', select), keys })

  it('takes a key that identifies every row', async () => {
    expect(await refusal(`SELECT * FROM (VALUES (1,'a'),(2,'b')) v(id, name)`, ['id'])).toBeNull()
  })

  it('names a column the version does not have', async () => {
    // The publisher dropped or renamed it after the key was settled. Issuing the
    // `MERGE` anyway is a binder error, with no reason recorded and the sweep
    // handing the version out again every hour (spec §6.6).
    expect(await refusal(`SELECT 1 AS id`, ['order_no'])).toBe('key-missing')
  })

  it('refuses a key column holding a null', async () => {
    // `=` never matches a null, so those rows would be re-inserted every version
    // and the key would stop being one inside the table (spec §6.4).
    expect(await refusal(`SELECT * FROM (VALUES (1),(NULL)) v(id)`, ['id'])).toBe('key-null')
  })

  it('refuses a key that repeats', async () => {
    expect(await refusal(`SELECT * FROM (VALUES (1,'a'),(1,'b')) v(id, name)`, ['id'])).toBe(
      'key-not-unique'
    )
  })

  it('asks about nulls before uniqueness', async () => {
    // `count(DISTINCT)` does not count nulls, so a key of nothing but nulls
    // reads as perfectly unique — the two questions are not independent.
    expect(await refusal(`SELECT * FROM (VALUES (NULL),(NULL)) v(id)`, ['id'])).toBe('key-null')
  })

  it('takes a composite key, and reads the pair rather than each column', async () => {
    const rows = `SELECT * FROM (VALUES (1,'x'),(1,'y')) v(a, b)`

    expect(await refusal(rows, ['a', 'b'])).toBeNull()
    expect(await refusal(rows, ['a'])).toBe('key-not-unique')
  })
})

/**
 * The other half of the purge's step down off the version it retracted (spec
 * §9.1 step 4).
 *
 * Which version the table goes to is settled against a real database elsewhere,
 * with these calls stubbed. What only a running catalog can answer is what the
 * move leaves behind: the contents have to come back, the table has to
 * *describe* as the restored shape (that is the input to the column check, and
 * to ii-b's `MERGE`), and the snapshots it stepped over have to survive it —
 * they are what the diffs of the versions in between resolve to.
 */
describe('a table stood back on an earlier snapshot, then ingested onto', () => {
  it('is what the next ingest reads, not the version it stepped off', async () => {
    const v1 = await ingest(await version('v1', `SELECT 1 AS id, 'a' AS name`))
    // A column appears, so the table now holds a shape v1 never had — the branch
    // that has to replace the table, since there is nothing to insert into.
    const v2 = await ingest(await version('v2', `SELECT 1 AS id, 'a' AS name, 'x' AS note`))

    await restandLakeTable(session, { table: TABLE, snapshot: v1.snapshotId })

    // A new snapshot carrying old contents — no catalog rewinds — and no version
    // row names it: the landing is not a publication (spec §7.2).
    const landed = await latestSnapshot()
    expect(landed).toBeGreaterThan(v2.snapshotId)
    expect(
      await session.rows(`SELECT * FROM lake.${TABLE} AT (VERSION => ${landed}) ORDER BY id`)
    ).toEqual([{ id: 1, name: 'a' }])
    // The shape an ingest would now compare against is v1's. Reading v2's here
    // is exactly the failure standing the table down exists to prevent.
    expect((await describeColumns(session, `lake.${TABLE}`)).map((c) => c.name)).toEqual([
      'id',
      'name',
    ])

    // And loading the next version onto it lands its contents, not a merge of
    // the two shapes.
    const v3 = await ingest(
      await version('v3', `SELECT 1 AS id, 'a' AS name UNION ALL SELECT 2, 'b'`)
    )
    expect(await session.rows(`SELECT * FROM lake.${TABLE} ORDER BY id`)).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ])

    // The stepped-over version is still readable at its own snapshot: the move
    // replaced contents, it did not rewind the catalog. The diff and the purge's
    // reclaim both depend on that.
    expect(
      await session.rows(`SELECT * FROM lake.${TABLE} AT (VERSION => ${v2.snapshotId}) ORDER BY id`)
    ).toEqual([{ id: 1, name: 'a', note: 'x' }])
    expect(v3.snapshotId).toBeGreaterThan(landed)
  })

  it('lands one snapshot when the columns did not move', async () => {
    // The other branch: same shape, so the contents are refilled inside one
    // transaction rather than the table being replaced. One snapshot per move,
    // like any other load.
    const v1 = await ingest(await version('v1', `SELECT 1 AS id, 'a' AS name`))
    const v2 = await ingest(
      await version('v2', `SELECT 1 AS id, 'a' AS name UNION ALL SELECT 9, 'z'`)
    )

    await restandLakeTable(session, { table: TABLE, snapshot: v1.snapshotId })

    expect(await latestSnapshot()).toBe(v2.snapshotId + 1)
    expect(await session.rows(`SELECT * FROM lake.${TABLE} ORDER BY id`)).toEqual([
      { id: 1, name: 'a' },
    ])
  })

  it('diffs against the version it was stood back on', async () => {
    // What an administrator sees after a purge followed by a new upload: the
    // change is measured from the version the table came down onto, not from the
    // one that was taken out.
    const v1 = await ingest(await version('v1', `SELECT 1 AS id, 'a' AS name`))
    await ingest(await version('v2', `SELECT 1 AS id, 'a' AS name UNION ALL SELECT 9, 'z'`))
    await restandLakeTable(session, { table: TABLE, snapshot: v1.snapshotId })
    const landed = await latestSnapshot()

    const v3 = await ingest(
      await version('v3', `SELECT 1 AS id, 'a' AS name UNION ALL SELECT 2, 'b'`)
    )

    const diff = await diffVersions(session, {
      table: TABLE,
      fromSnapshot: landed,
      toSnapshot: v3.snapshotId,
    })

    // One row added. Measured from v2 instead, the purged row would show as
    // removed and the answer would be 1 added / 1 removed.
    expect(diff).toMatchObject({ schemaChanged: false, addedRows: 1, removedRows: 0 })
  })
})
