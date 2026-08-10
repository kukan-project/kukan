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
import { buildDiffQuery, splitDiffRows } from '../diff'
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
