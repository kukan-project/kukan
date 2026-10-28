import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DuckDBInstance } from '@duckdb/node-api'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interpretCsv } from '@/pipeline/interpret/table/csv'

/**
 * The reader's own decisions, called in this process. The step's tests
 * (`interpret.test.ts`, `interpret-typing.test.ts`) reach the same function
 * through the heavy process, which coverage does not follow, so some inputs
 * here repeat theirs.
 */
describe('interpretCsv — reading the file', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kukan-csv-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function interpret(content: string, skipRows = 0) {
    const csvPath = join(dir, 'in.csv')
    writeFileSync(csvPath, content)
    return interpretCsv(csvPath, join(dir, 'out.parquet'), skipRows)
  }

  const names = (columns: { name: string }[]) => columns.map((c) => c.name)

  /** One column of the written preview, as DuckDB reads it back. */
  async function previewColumn(column: string): Promise<unknown[]> {
    const conn = await (await DuckDBInstance.create(':memory:')).connect()
    try {
      const reader = await conn.runAndReadAll(
        `SELECT "${column}" AS v FROM read_parquet('${join(dir, 'out.parquet')}')`
      )
      return (reader.getRowObjectsJson() as { v: unknown }[]).map((r) => r.v)
    } finally {
      conn.disconnectSync()
    }
  }

  it('skips the title rows the caller found above the header', async () => {
    const { schema } = await interpret('人口統計\n単位: 人\nname,count\na,1\nb,2\n', 2)

    expect(names(schema.columns)).toEqual(['name', 'count'])
    expect(schema.columns[1].type).toBe('integer')
    expect(schema.rowCount).toBe(2)
  })

  it('reads integers past what a double holds as text, every digit kept', async () => {
    // Twenty digits is past BIGINT, so the sniffer makes the column DOUBLE and
    // the first value would come back as 1e+20
    const { schema } = await interpret('id,big\n1,99999999999999999999\n2,12345678901234567890\n')

    expect(schema.columns.map((c) => c.type)).toEqual(['integer', 'string'])
    expect(await previewColumn('big')).toEqual(['99999999999999999999', '12345678901234567890'])
  })

  it('keeps a double column whose values are fractional', async () => {
    const { schema } = await interpret('id,ratio\n1,1.5\n2,2.25\n')

    expect(schema.columns[1].type).toBe('float')
  })

  it('takes the byte-order mark the reader left off the first column name', async () => {
    // The reader strips one mark; a file round-tripped through Excel carries two
    const { schema } = await interpret('﻿﻿name,count\na,1\n')

    expect(names(schema.columns)).toEqual(['name', 'count'])
    expect(await previewColumn('name')).toEqual(['a'])
  })

  it('leaves the mark where the bare name is another column’s', async () => {
    // DuckDB's names compare case-insensitively, so `name` and `NAME` are one
    const { schema } = await interpret('﻿﻿name,NAME\na,1\n')

    expect(names(schema.columns)).toEqual(['﻿name', 'NAME'])
  })

  it('leaves the mark where it is the whole name', async () => {
    const { schema } = await interpret('﻿﻿,count\na,1\n')

    expect(names(schema.columns)).toEqual(['﻿', 'count'])
  })

  it('reads a file of a header alone as a table without rows', async () => {
    const { schema } = await interpret('a,b,c\n')

    expect(names(schema.columns)).toEqual(['a', 'b', 'c'])
    expect(schema.rowCount).toBe(0)
    expect(schema.droppedRows).toBeUndefined()
  })

  it('trims only the run of notes that reaches the bottom of the file', async () => {
    const header = Array.from({ length: 6 }, (_, i) => `c${i}`).join(',')
    const row = (r: number) => Array.from({ length: 6 }, (_, i) => r * 10 + i).join(',')
    const note = '出典: 港区,,,,,'
    const { schema } = await interpret(
      [header, row(1), note, row(2), note, '注: 速報値,,,,,', ''].join('\n')
    )

    expect(schema.rowCount).toBe(3)
    expect(schema.droppedRows).toBe(2)
    // The note between two rows stays: it is the table's business, not a footer
    expect(await previewColumn('c0')).toEqual(['10', '出典: 港区', '20'])
  })

  it('reads a file the sniffer cannot settle off the standard, and says so', async () => {
    // Line endings mixed within one file: the standard reader fails before a row
    const { schema, reason } = await interpret('a,b,c\r\n1,2,3\n4,5,6\r\n7,8,9\n')

    expect(reason).toBeUndefined()
    expect(schema.rowCount).toBe(3)
    expect(schema.lenient).toBe(true)
    expect(schema.columns.map((c) => c.type)).toEqual(['integer', 'integer', 'integer'])
  })

  it('drops a sign-off from a file read off the standard, and says both', async () => {
    const { schema, reason } = await interpret('a,b,c,d,e,f\r\n1,2,3,4,5,6\n7,8\r\n1,2,3,4,5,6\n')

    expect(reason).toBeUndefined()
    expect(schema).toMatchObject({ rowCount: 2, droppedRows: 1, droppedLines: [3], lenient: true })
  })

  it('refuses a broken row in a file read off the standard, and says it was', async () => {
    // A row of three columns short by one is a row, not a sign-off
    const { schema, reason } = await interpret('a,b,c\r\n1,2,3\n4,5\r\n7,8,9\n')

    expect(reason).toBe('ragged-rows')
    expect(schema).toMatchObject({ columns: [], droppedLines: [3], lenient: true })
    expect(existsSync(join(dir, 'out.parquet'))).toBe(false)
  })

  it('fails on a file it cannot open, which is no failed sniff', async () => {
    await expect(
      interpretCsv(join(dir, 'missing.csv'), join(dir, 'out.parquet'), 0)
    ).rejects.toThrow(/IO Error/)
  })
})
