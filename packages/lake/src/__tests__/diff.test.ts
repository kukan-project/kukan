/**
 * The diff query's semantics, run against a plain in-memory DuckDB.
 *
 * `buildDiffQuery` takes FROM clauses rather than a snapshot, so the rules that
 * are easy to get wrong — duplicates counted individually, NULLs matching, the
 * sample bounded — are testable without a DuckLake catalog. What snapshot those
 * clauses name is `diffVersions`' concern.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { buildDiffQuery, buildKeyedDiffQuery, splitDiffRows, splitKeyedDiffRows } from '../diff'
import type { LakeColumn } from '../columns'
import type { LakeRow } from '../connection'

const COLUMNS: LakeColumn[] = [
  { name: 'id', type: 'INTEGER' },
  { name: 'name', type: 'VARCHAR' },
]

let connection: DuckDBConnection

beforeAll(async () => {
  const instance = await DuckDBInstance.create(':memory:')
  connection = await instance.connect()
})

afterAll(() => {
  connection?.closeSync()
})

/** Load the two sides, then run the diff over them. */
async function diff(
  from: [number | null, string | null][],
  to: [number | null, string | null][],
  columns: LakeColumn[] = COLUMNS
) {
  const values = (rows: (number | null | string)[][]) =>
    rows.length === 0
      ? `SELECT * FROM (VALUES (NULL::INTEGER, NULL::VARCHAR)) t(id, name) WHERE false`
      : rows
          .map(
            (r) =>
              `SELECT ${r[0] === null ? 'NULL::INTEGER' : r[0]} AS id, ` +
              `${r[1] === null ? 'NULL::VARCHAR' : `'${r[1]}'`} AS name`
          )
          .join(' UNION ALL ')

  const { sql, net, total } = buildDiffQuery(`(${values(from)})`, `(${values(to)})`, columns)
  const result = await connection.runAndReadAll(sql)
  return splitDiffRows(result.getRowObjects() as LakeRow[], net, total)
}

describe('buildDiffQuery', () => {
  it('reports nothing when the two sides hold the same rows', async () => {
    const rows: [number, string][] = [
      [1, 'a'],
      [2, 'b'],
    ]
    expect(await diff(rows, rows)).toMatchObject({
      addedRows: 0,
      removedRows: 0,
      sampleAdded: [],
      sampleRemoved: [],
    })
  })

  it('counts an addition and a removal separately', async () => {
    const result = await diff(
      [
        [1, 'a'],
        [2, 'b'],
      ],
      [
        [1, 'a'],
        [3, 'c'],
      ]
    )

    // `keyed` asserted with the counts it qualifies: without it, a reader of a
    // later release cannot tell "no edits" from "edits not measured", and this
    // answer means the second (ii-a compares whole rows).
    expect(result).toMatchObject({ keyed: false, addedRows: 1, removedRows: 1 })
    expect(result.schemaChanged).toBe(false)
    if (result.schemaChanged) return
    expect(result.sampleAdded).toEqual([{ id: 3, name: 'c' }])
    expect(result.sampleRemoved).toEqual([{ id: 2, name: 'b' }])
  })

  it('counts duplicate rows individually', async () => {
    // Dropping one of three identical rows is a change; a set difference would
    // call it no change at all.
    const result = await diff(
      [
        [1, 'a'],
        [1, 'a'],
        [1, 'a'],
      ],
      [
        [1, 'a'],
        [1, 'a'],
      ]
    )

    expect(result).toMatchObject({ addedRows: 0, removedRows: 1 })
    if (result.schemaChanged) return
    // One sampled row rather than the same row listed once per lost copy.
    expect(result.sampleRemoved).toEqual([{ id: 1, name: 'a' }])
  })

  it('treats a row as unchanged when both sides hold the same NULLs', async () => {
    const rows: [number | null, string | null][] = [
      [1, null],
      [null, 'b'],
    ]
    expect(await diff(rows, rows)).toMatchObject({ addedRows: 0, removedRows: 0 })
  })

  it('sees a NULL replaced by a value as one removal and one addition', async () => {
    expect(await diff([[1, null]], [[1, 'a']])).toMatchObject({
      addedRows: 1,
      removedRows: 1,
    })
  })

  it('counts every changed row but samples at most five per side', async () => {
    const from: [number, string][] = Array.from({ length: 20 }, (_, i) => [i, 'old'])
    const to: [number, string][] = Array.from({ length: 20 }, (_, i) => [i, 'new'])

    const result = await diff(from, to)

    // The counts are the full totals; only what crosses into JS is capped.
    expect(result).toMatchObject({ addedRows: 20, removedRows: 20 })
    if (result.schemaChanged) return
    expect(result.sampleAdded).toHaveLength(5)
    expect(result.sampleRemoved).toHaveLength(5)
  })

  it('reports a one-sided diff without inventing the other side', async () => {
    const result = await diff([], [[1, 'a']])

    expect(result).toMatchObject({ addedRows: 1, removedRows: 0 })
    if (result.schemaChanged) return
    expect(result.sampleRemoved).toEqual([])
  })

  it('trims wide text cells in the sample but groups on the full value', async () => {
    const long = 'x'.repeat(600)
    const result = await diff([], [[1, long]])

    if (result.schemaChanged) return
    const [row] = result.sampleAdded
    expect(String(row.name)).toHaveLength(513) // 512 + the ellipsis
    expect(String(row.name).endsWith('…')).toBe(true)
  })

  it('does not collide with a user column named like the marker', async () => {
    // CSV headers become column names, so `__net` is not reserved.
    const columns: LakeColumn[] = [
      { name: '__net', type: 'INTEGER' },
      { name: '__total', type: 'VARCHAR' },
    ]
    const { sql, net, total } = buildDiffQuery(
      `(SELECT 1 AS "__net", 'a' AS "__total")`,
      `(SELECT 2 AS "__net", 'b' AS "__total")`,
      columns
    )
    expect(net).not.toBe('__net')
    expect(total).not.toBe('__total')

    const result = await connection.runAndReadAll(sql)
    const diffResult = splitDiffRows(result.getRowObjects() as LakeRow[], net, total)

    expect(diffResult).toMatchObject({ addedRows: 1, removedRows: 1 })
    if (diffResult.schemaChanged) return
    expect(diffResult.sampleAdded).toEqual([{ __net: 2, __total: 'b' }])
  })
})

/** The keyed side of the same file: rows matched by a key rather than whole. */
async function keyedDiff(
  from: [number | null, string | null][],
  to: [number | null, string | null][],
  key: string[] = ['id'],
  columns: LakeColumn[] = COLUMNS
) {
  const values = (rows: (number | null | string)[][]) =>
    rows.length === 0
      ? `SELECT * FROM (VALUES (NULL::INTEGER, NULL::VARCHAR)) t(id, name) WHERE false`
      : rows
          .map(
            (r) =>
              `SELECT ${r[0] === null ? 'NULL::INTEGER' : r[0]} AS id, ` +
              `${r[1] === null ? 'NULL::VARCHAR' : `'${r[1]}'`} AS name`
          )
          .join(' UNION ALL ')

  const { sql, markers } = buildKeyedDiffQuery(`(${values(from)})`, `(${values(to)})`, columns, key)
  const result = await connection.runAndReadAll(sql)
  return splitKeyedDiffRows(result.getRowObjects() as LakeRow[], markers)
}

describe('buildKeyedDiffQuery', () => {
  it('reports nothing when the two sides hold the same rows', async () => {
    const rows: [number, string][] = [
      [1, 'a'],
      [2, 'b'],
    ]
    expect(await keyedDiff(rows, rows)).toMatchObject({
      addedRows: 0,
      removedRows: 0,
      changedRows: 0,
      sampleChangedAfter: [],
    })
  })

  it('takes a column named like its own bookkeeping', async () => {
    // CSV headers become column names, so `__kind` is not off-limits to a
    // dataset — the same collision the keyless query renames around.
    const columns: LakeColumn[] = [
      { name: 'id', type: 'INTEGER' },
      { name: '__kind', type: 'VARCHAR' },
    ]
    const values = (name: string) => `SELECT 1 AS id, '${name}' AS __kind`
    const { sql, markers } = buildKeyedDiffQuery(`(${values('a')})`, `(${values('b')})`, columns, [
      'id',
    ])
    const result = await connection.runAndReadAll(sql)

    expect(splitKeyedDiffRows(result.getRowObjects() as LakeRow[], markers)).toMatchObject({
      changedRows: 1,
      sampleChangedAfter: [{ id: 1, __kind: 'b' }],
      sampleChangedBefore: [{ __kind: 'a' }],
    })
  })

  it('carries what a changed row held before, for the columns that can differ', async () => {
    // The new values alone say a row changed and nothing to read them against,
    // which is the one thing "changed" is supposed to say. The key is not
    // repeated: it matched, so both sides hold it.
    expect(await keyedDiff([[1, 'a']], [[1, 'b']])).toMatchObject({
      changedRows: 1,
      sampleChangedAfter: [{ id: 1, name: 'b' }],
      sampleChangedBefore: [{ name: 'a' }],
    })
  })

  it("carries a null the row actually held, not the guard's null", async () => {
    // The before side is nulled out for added and removed rows, and a value
    // that *was* null has to survive that — the panel tells them apart by
    // whether the column is present at all, so a changed row must carry the
    // key even when its value is null.
    const diff = await keyedDiff([[1, null]], [[1, 'b']])
    expect(diff).toMatchObject({ changedRows: 1, sampleChangedAfter: [{ id: 1, name: 'b' }] })
    expect((diff as { sampleChangedBefore: LakeRow[] }).sampleChangedBefore[0]).toEqual({
      name: null,
    })
  })

  it('leaves the before side empty for a row that only ever had one', async () => {
    // An added row has no `from` and a removed one no `to`; the half that
    // exists is already in the sample it belongs to.
    const diff = await keyedDiff([[1, 'a']], [[2, 'b']])
    expect(diff).toMatchObject({ addedRows: 1, removedRows: 1, sampleChangedBefore: [] })
  })

  it('takes a column named like the prefix its own before-side uses', async () => {
    const columns: LakeColumn[] = [
      { name: 'id', type: 'INTEGER' },
      { name: '__before_id', type: 'VARCHAR' },
    ]
    const values = (name: string) => `SELECT 1 AS id, '${name}' AS __before_id`
    const { sql, markers } = buildKeyedDiffQuery(`(${values('a')})`, `(${values('b')})`, columns, [
      'id',
    ])
    const result = await connection.runAndReadAll(sql)

    expect(splitKeyedDiffRows(result.getRowObjects() as LakeRow[], markers)).toMatchObject({
      changedRows: 1,
      sampleChangedAfter: [{ id: 1, __before_id: 'b' }],
      sampleChangedBefore: [{ __before_id: 'a' }],
    })
  })

  it('bounds the sample while counting every row', async () => {
    const many = Array.from({ length: 12 }, (_, i): [number, string] => [i, 'x'])
    const result = await keyedDiff([], many)

    expect(result).toMatchObject({ addedRows: 12 })
    if (result.schemaChanged || !result.keyed) throw new Error('expected a keyed diff')
    expect(result.sampleAdded).toHaveLength(5)
  })

  it('trims a wide cell in the sample, as the keyless query does', async () => {
    const wide = 'x'.repeat(600)
    const result = await keyedDiff([[1, 'a']], [[1, wide]])

    if (result.schemaChanged || !result.keyed) throw new Error('expected a keyed diff')
    expect(String(result.sampleChangedAfter[0].name)).toHaveLength(513)
  })

  it('carries the before side of a cell that moved past where the sample is cut', async () => {
    // Both values trim to the same 512 characters, so the two sides of the
    // sample arrive equal — a reader deciding from what it was sent would call
    // the one cell that moved unmoved. Whether it moved is answered here, over
    // the whole value.
    const shared = 'x'.repeat(600)
    const result = await keyedDiff([[1, `${shared}a`]], [[1, `${shared}b`]])

    if (result.schemaChanged || !result.keyed) throw new Error('expected a keyed diff')
    expect(result.changedRows).toBe(1)
    expect(result.sampleChangedBefore[0]).toHaveProperty('name')
    expect(result.sampleChangedAfter[0].name).toEqual(result.sampleChangedBefore[0].name)
  })

  it('leaves a column that held still out of the before side', async () => {
    // What the panel marks is what this row carries, so a column that did not
    // move must not be in it — otherwise every column of a changed row is shown
    // as changed.
    const columns: LakeColumn[] = [
      { name: 'id', type: 'INTEGER' },
      { name: 'moved', type: 'VARCHAR' },
      { name: 'held', type: 'VARCHAR' },
    ]
    const row = (moved: string) => `SELECT 1 AS id, '${moved}' AS moved, 'same' AS held`
    const { sql, markers } = buildKeyedDiffQuery(`(${row('a')})`, `(${row('b')})`, columns, ['id'])
    const result = await connection.runAndReadAll(sql)
    const diff = splitKeyedDiffRows(result.getRowObjects() as LakeRow[], markers)

    expect(diff).toMatchObject({ changedRows: 1 })
    if (diff.schemaChanged || !diff.keyed) throw new Error('expected a keyed diff')
    expect(diff.sampleChangedBefore[0]).toEqual({ moved: 'a' })
  })
})
