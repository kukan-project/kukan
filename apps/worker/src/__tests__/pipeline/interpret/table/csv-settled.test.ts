import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DuckDBInstance } from '@duckdb/node-api'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interpretCsv } from '@/pipeline/interpret/table/csv'
import type { ResourceColumn } from '@kukan/shared'
import type { SettledReading } from '@/pipeline/interpret/table/settled-types'

/** Settled column types read onto a CSV (Versioning ii-c §8.3). */
describe('interpretCsv — settled types', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kukan-settled-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function interpret(content: string, reading: SettledReading) {
    const csvPath = join(dir, 'in.csv')
    writeFileSync(csvPath, content)
    return interpretCsv(csvPath, join(dir, 'out.parquet'), 0, undefined, reading)
  }

  const column = (columns: ResourceColumn[], name: string) => columns.find((c) => c.name === name)!

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

  it('reads a column settled as text as written, though inference read integers', async () => {
    const { schema } = await interpret('code,n\n7,1\n10,2\n', { types: { code: 'string' } })
    expect(column(schema.columns, 'code')).toMatchObject({
      type: 'string',
      settled: true,
      inferredType: 'integer',
    })
    expect(await preview('code')).toEqual(['7', '10'])
  })

  it('keeps the leading zeros of a column settled as text', async () => {
    // Inference already reads such a column as text over every row; settling
    // it keeps it so when a later file happens to hold no leading zero
    const { schema } = await interpret('code,n\n007,1\n010,2\n', { types: { code: 'string' } })
    expect(column(schema.columns, 'code')).toMatchObject({ type: 'string', settled: true })
    expect(await preview('code')).toEqual(['007', '010'])
  })

  it('leaves a value that does not convert empty, counts it and keeps the row', async () => {
    const { schema } = await interpret('n\n1\nunknown\n3\n', { types: { n: 'integer' } })
    expect(schema.rowCount).toBe(3)
    expect(column(schema.columns, 'n')).toMatchObject({
      type: 'integer',
      settled: true,
      inferredType: 'string',
      castFailures: 1,
      castFailureSamples: [{ row: 2, value: 'unknown' }],
    })
    expect(await preview('n')).toEqual(['1', null, '3'])
  })

  it('reads a value of marks alone as empty, not as a value that did not convert', async () => {
    // Statistical tables write `-` or `…` where there is no value
    const { schema } = await interpret('n\n1\n-\n…\n － \nx\n6\n', { types: { n: 'integer' } })
    expect(column(schema.columns, 'n')).toMatchObject({
      noValueMarks: { count: 4, examples: ['-', 'x', '…'] },
    })
    expect(column(schema.columns, 'n').castFailures).toBeUndefined()
    expect(await preview('n')).toEqual(['1', null, null, null, null, '6'])
  })

  it('does not round a fraction into an integer column, and reads grouped digits', async () => {
    const { schema } = await interpret('n\n"1,234"\n1.5\n 7 \n', { types: { n: 'integer' } })
    expect(await preview('n')).toEqual(['1234', null, '7'])
    expect(column(schema.columns, 'n').castFailures).toBe(1)
  })

  it('decides decimal digits from the values, leading zeros taking none', async () => {
    const { schema } = await interpret('rate\n0.125\n12.5\n007\n', { types: { rate: 'decimal' } })
    expect(column(schema.columns, 'rate')).toMatchObject({
      type: 'decimal',
      decimalPrecision: 5,
      decimalScale: 3,
    })
    expect(column(schema.columns, 'rate').castFailures).toBeUndefined()
    expect(await preview('rate')).toEqual(['0.125', '12.500', '7.000'])
  })

  it('takes the previous digits, or the default, where no value is readable', async () => {
    const previous = await interpret('rate\nunknown\n', {
      types: { rate: 'decimal' },
      previous: { rate: { decimalPrecision: 10, decimalScale: 2 } },
    })
    expect(column(previous.schema.columns, 'rate')).toMatchObject({
      decimalPrecision: 10,
      decimalScale: 2,
      castFailures: 1,
    })
    const none = await interpret('rate\nunknown\n', { types: { rate: 'decimal' } })
    expect(column(none.schema.columns, 'rate')).toMatchObject({
      decimalPrecision: 18,
      decimalScale: 3,
    })
  })

  it('reads a date in the format most of its values take', async () => {
    const { schema } = await interpret('d\n31/12/2026\n30/11/2026\nunknown\n', {
      types: { d: 'date' },
    })
    expect(column(schema.columns, 'd')).toMatchObject({
      type: 'date',
      dateFormat: '%d/%m/%Y',
      castFailures: 1,
    })
    expect(await preview('d')).toEqual(['2026-12-31', '2026-11-30', null])
  })

  it('reads every date shape the sniffer reads, dots and spaces included', async () => {
    const { schema } = await interpret(
      'a,b,c\n2026.11.21,11.21.2026,2026 11 21\n2026.11.30,11.30.2026,2026 11 30\n',
      {
        types: { a: 'date', b: 'date', c: 'date' },
      }
    )
    expect(schema.columns.map((c) => c.dateFormat)).toEqual(['%Y.%m.%d', '%m.%d.%Y', '%Y %m %d'])
    expect(await preview('b')).toEqual(['2026-11-21', '2026-11-30'])
  })

  it('does not read a two-digit year as a four-digit one', async () => {
    // `99-12-31` can only be year first, which settles the column
    const { schema } = await interpret('d\n26-11-21\n99-12-31\n', { types: { d: 'date' } })
    expect(column(schema.columns, 'd').dateFormat).toBe('%y-%m-%d')
    expect(await preview('d')).toEqual(['2026-11-21', '1999-12-31'])
  })

  it('leaves a date as text when its formats tie on different dates', async () => {
    const { schema } = await interpret('d\n01/02/2026\n03/04/2026\n', { types: { d: 'date' } })
    expect(column(schema.columns, 'd')).toMatchObject({
      type: 'string',
      settled: true,
      dateFormatUndecided: true,
    })
    expect(await preview('d')).toEqual(['01/02/2026', '03/04/2026'])
  })

  it('breaks such a tie with the previous format, or reads the format the setting names', async () => {
    const tie = await interpret('d\n01/02/2026\n', {
      types: { d: 'date' },
      previous: { d: { dateFormat: '%m/%d/%Y' } },
    })
    expect(column(tie.schema.columns, 'd').dateFormat).toBe('%m/%d/%Y')
    expect(await preview('d')).toEqual(['2026-01-02'])

    const named = await interpret('d\n01/02/2026\n', { types: { d: 'date:%d/%m/%Y' } })
    expect(column(named.schema.columns, 'd').dateFormat).toBe('%d/%m/%Y')
    expect(await preview('d')).toEqual(['2026-02-01'])
  })

  it('keeps the rows in order and numbers samples by row beside a column named rowid', async () => {
    const { schema } = await interpret('ROWID,v\nb,1\na,y\n', { types: { v: 'integer' } })
    expect(column(schema.columns, 'v').castFailureSamples).toEqual([{ row: 2, value: 'y' }])
    expect(column(schema.columns, 'ROWID').type).toBe('string')
    expect(await preview('ROWID')).toEqual(['b', 'a'])
    expect(await preview('v')).toEqual(['1', null])
  })

  it('reads ISO 8601 timestamps with a fraction or an offset, the offset ones in UTC', async () => {
    const { schema } = await interpret(
      'at\n2026-11-21T12:34:56.123Z\n2026-11-21T12:34:56+09:00\n2026-11-21 12:34\n',
      { types: { at: 'timestamp' } }
    )
    expect(column(schema.columns, 'at')).toMatchObject({ type: 'timestamp', dateFormat: 'iso8601' })
    expect(column(schema.columns, 'at').castFailures).toBeUndefined()
    expect(await preview('at')).toEqual([
      '2026-11-21 12:34:56.123',
      '2026-11-21 03:34:56',
      '2026-11-21 12:34:00',
    ])
  })

  it('reads seconds with a fraction or without under one format', async () => {
    const { schema } = await interpret('at\n2026/12/31 12:34:56.123\n2026/12/31 12:34:57\n', {
      types: { at: 'timestamp' },
    })
    expect(column(schema.columns, 'at')).toMatchObject({ dateFormat: '%Y/%m/%d %H:%M:%S' })
    expect(column(schema.columns, 'at').castFailures).toBeUndefined()
    expect(await preview('at')).toEqual(['2026-12-31 12:34:56.123', '2026-12-31 12:34:57'])
  })

  it('reads again as a version was read, with its format and digits, not deciding them anew', async () => {
    // The values alone would leave the date undecided and choose DECIMAL(3, 2)
    const { schema } = await interpret('d,r\n01/02/2026,1.25\n', {
      types: { d: 'date', r: 'decimal' },
      previous: {
        d: { dateFormat: '%d/%m/%Y' },
        r: { decimalPrecision: 10, decimalScale: 3 },
      },
      fixed: true,
    })
    expect(column(schema.columns, 'd').dateFormat).toBe('%d/%m/%Y')
    expect(column(schema.columns, 'r')).toMatchObject({ decimalPrecision: 10, decimalScale: 3 })
    expect(await preview('d')).toEqual(['2026-02-01'])

    const undecided = await interpret('d\n01/02/2026\n', {
      types: { d: 'date' },
      previous: { d: { dateFormatUndecided: true } },
      fixed: true,
    })
    expect(column(undecided.schema.columns, 'd')).toMatchObject({
      type: 'string',
      dateFormatUndecided: true,
    })
  })

  it('names a settled column the file does not have, and reads the rest', async () => {
    const { schema } = await interpret('a\n1\n', { types: { a: 'string', gone: 'integer' } })
    expect(schema.missingSettled).toEqual(['gone'])
    expect(column(schema.columns, 'a').type).toBe('string')
  })

  it('matches a settled first column whose header carries a byte order mark', async () => {
    const { schema } = await interpret('﻿code,n\n007,1\n', { types: { code: 'string' } })
    expect(column(schema.columns, 'code')).toMatchObject({ type: 'string', settled: true })
    expect(await preview('code')).toEqual(['007'])
  })
})
