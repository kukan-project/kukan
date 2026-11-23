import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { interpretCsv, type CsvStructure } from '@/pipeline/interpret/table/csv'

describe('interpretCsv with a given structure', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kukan-csv-given-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const GIVEN: CsvStructure = { given: { textColumns: [] } }
  const INFERRED: CsvStructure = { inferred: { skipRows: 0 } }

  function interpret(content: string, structure: CsvStructure) {
    const csvPath = join(dir, 'in.csv')
    writeFileSync(csvPath, content)
    return interpretCsv(csvPath, join(dir, 'out.parquet'), { structure })
  }

  const names = (columns: { name: string }[]) => columns.map((c) => c.name)

  it('takes the first line for the header even when it reads like data', async () => {
    const csv = '2020,2021,2022\n1,2,3\n4,5,6\n'
    const given = await interpret(csv, GIVEN)
    expect(names(given.schema.columns)).toEqual(['2020', '2021', '2022'])
    expect(given.schema.rowCount).toBe(2)
  })

  it('keeps a sparse last row that the inferred structure takes for a note', async () => {
    const header = '地区,1月,2月,3月,4月,5月,6月,計'
    const rows = Array.from({ length: 6 }, (_, i) => `区${i},1,2,3,4,5,6,21`)
    const csv = [header, ...rows, '合計,,,,,,,126', ''].join('\n')

    const inferred = await interpret(csv, INFERRED)
    expect(inferred.schema.rowCount).toBe(6)

    const given = await interpret(csv, GIVEN)
    expect(given.schema.rowCount).toBe(7)
    expect(given.schema.droppedRows ?? 0).toBe(0)
  })

  it('refuses a broken row rather than reading it as a note', async () => {
    const csv = 'a,b,c\n1,2,3\n4,5,6\n7,8\n'
    const given = await interpret(csv, GIVEN)
    expect(given.schema.columns).toEqual([])
    expect(given.reason).toBe('ragged-rows')
  })

  it('reads the dialect it was written in, whatever the values look like', async () => {
    // Every value in `'`: a sniffer takes `'` for the quote and drops them
    await interpret("name,note\n'a','x'\n'b','y'\n'c','z'\n", GIVEN)
    expect(await preview('name')).toEqual(["'a'", "'b'", "'c'"])

    // More `;` than `,` on every line: a sniffer takes `;` for the delimiter
    const semicolons = await interpret('a;x;y,b\n1;2;3,4\n5;6;7,8\n9;1;2,3\n', GIVEN)
    expect(names(semicolons.schema.columns)).toEqual(['a;x;y', 'b'])
    expect(semicolons.schema.rowCount).toBe(3)
  })

  /** One column of the written preview, as DuckDB reads it back. */
  async function preview(name: string): Promise<unknown[]> {
    const instance = await DuckDBInstance.create(':memory:')
    const conn = await instance.connect()
    try {
      const reader = await conn.runAndReadAll(
        `SELECT "${name}"::VARCHAR AS v FROM read_parquet('${join(dir, 'out.parquet')}')`
      )
      return (reader.getRowObjectsJson() as { v: unknown }[]).map((r) => r.v)
    } finally {
      conn.disconnectSync()
      instance.closeSync()
    }
  }

  it('reads the columns it is told to as text, and calls them strings', async () => {
    const csvPath = join(dir, 'in.csv')
    writeFileSync(csvPath, 'code,n\n00123,1\n00456,2\n')
    const { schema } = await interpretCsv(csvPath, join(dir, 'out.parquet'), {
      structure: { given: { textColumns: ['code'] } },
      reading: { types: { code: 'string' } },
    })
    const code = schema.columns.find((c) => c.name === 'code')!
    expect(code.type).toBe('string')
    expect(code.inferredType).toBe('string')
  })
})
