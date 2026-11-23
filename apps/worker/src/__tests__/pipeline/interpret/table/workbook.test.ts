import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gridSheet, type GridRow, type GridSheet } from '@/pipeline/interpret/table/grid'
import { interpretWorkbook, writeRangeCsv } from '@/pipeline/interpret/table/workbook'
import { xlsxBuffer } from '../../../test-helpers/xlsx'
import { biff, cell, layoutRecord, sstData, xlsBuffer } from '../../../test-helpers/legacy-office'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kukan-workbook-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function sheetOf(name: string, rows: GridRow[], index = 1): GridSheet {
  return gridSheet({ sheet: index, name, hidden: false }, () => rows)
}

async function* book(...sheets: GridSheet[]): AsyncGenerator<GridSheet> {
  yield* sheets
}

describe('writeRangeCsv', () => {
  const range = { top: 2, left: 2, bottom: 5, right: 4 }

  async function write(rows: GridRow[], others: GridSheet[] = []) {
    const csvPath = join(dir, 'out.csv')
    const result = await writeRangeCsv(
      book(...others, sheetOf('表', rows, others.length + 1)),
      { sheetNumber: others.length + 1, range, columnNames: ['コード', '名称, 略称', '日付'] },
      csvPath
    )
    if ('tooLarge' in result) throw new Error('A few rows are not too large')
    return { ...result, csv: await readFile(csvPath, 'utf-8') }
  }

  it('writes the names, then the range below the header, raw and quoted where needed', async () => {
    const { csv } = await write([
      { row: 1, cells: [{ col: 2, kind: 'text', value: '表題' }] },
      {
        row: 2,
        cells: [
          { col: 2, kind: 'text', value: 'header, not written' },
          { col: 3, kind: 'text', value: 'x' },
        ],
      },
      {
        row: 3,
        cells: [
          { col: 1, kind: 'text', value: 'left of the range' },
          { col: 2, kind: 'text', value: '00123' },
          { col: 3, kind: 'text', value: 'say "hi"\nthere' },
          { col: 4, kind: 'date', value: '2024-04-01' },
        ],
      },
      { row: 4, hidden: true, cells: [{ col: 3, kind: 'number', value: '1234.5' }] },
      {
        row: 5,
        cells: [
          { col: 2, kind: 'text', value: '   ' },
          { col: 4, kind: 'date', value: '2024-04-01T09:30:00' },
          { col: 5, kind: 'text', value: 'right of the range' },
        ],
      },
      { row: 6, cells: [{ col: 2, kind: 'text', value: '注記' }] },
    ])
    expect(csv).toBe(
      [
        'コード,"名称, 略称",日付',
        '00123,"say ""hi""\nthere",2024-04-01',
        ',1234.5,',
        ',,2024-04-01T09:30:00',
        '',
      ].join('\n')
    )
  })

  it('reads the sheet it was judged on, past the others', async () => {
    const other = sheetOf('表紙', [{ row: 3, cells: [{ col: 2, kind: 'text', value: 'no' }] }])
    const { csv } = await write(
      [{ row: 3, cells: [{ col: 2, kind: 'text', value: 'yes' }] }],
      [other]
    )
    expect(csv.split('\n')[1]).toBe('yes,,')
  })

  it('stops past the largest CSV an interpretation reads', async () => {
    const rows: GridRow[] = Array.from({ length: 5000 }, (_, i) => ({
      row: i + 3,
      cells: [{ col: 2, kind: 'number', value: String(i) }],
    }))
    const sheets = book(sheetOf('表', rows))
    const reading = {
      sheetNumber: 1,
      range: { ...range, bottom: 5002 },
      columnNames: ['a', 'b', 'c'],
    }
    expect(await writeRangeCsv(sheets, reading, join(dir, 'out.csv'), 1000)).toEqual({
      tooLarge: true,
    })
  })

  it('names the columns whose values are all strings', async () => {
    const { textColumns } = await write([
      {
        row: 3,
        cells: [
          { col: 2, kind: 'text', value: '001' },
          { col: 3, kind: 'text', value: 'a' },
          { col: 4, kind: 'date', value: '2024-04-01' },
        ],
      },
      {
        row: 4,
        cells: [
          { col: 2, kind: 'text', value: '002' },
          { col: 3, kind: 'number', value: '1' },
        ],
      },
    ])
    expect(textColumns).toEqual(['コード'])
  })
})

describe('interpretWorkbook', () => {
  async function interpret(file: Buffer, name = 'book.xlsx') {
    const path = join(dir, name)
    await writeFile(path, file)
    const csvPath = join(dir, 'table.csv')
    const result = await interpretWorkbook(path, csvPath, join(dir, 'out.parquet'))
    // A working file, never kept
    expect(existsSync(csvPath)).toBe(false)
    return result
  }

  const shared = (...strings: string[]) => strings.map((s) => `<si><t>${s}</t></si>`)

  /** A sheet of codes stored as strings, names and counts, under a title. */
  async function plainXlsx(): Promise<Buffer> {
    const rows = [
      [{ s: 0 }],
      [{ s: 1 }, { s: 2 }, { s: 3 }],
      ...Array.from({ length: 12 }, (_, i) => [
        { inline: `00${i + 1}` },
        { inline: `施設${i + 1}` },
        i * 10,
      ]),
    ]
    return xlsxBuffer({
      shared: shared('施設の一覧', 'コード', '名称', '人数'),
      sheets: { 1: rows },
    })
  }

  it('reads a plain sheet as a table, a code stored as a string kept as one', async () => {
    const result = await interpret(await plainXlsx())

    expect(result.reason).toBeUndefined()
    expect(result.schema.rowCount).toBe(12)
    expect(result.schema.columns.map((c) => [c.name, c.type])).toEqual([
      ['コード', 'string'],
      ['名称', 'string'],
      ['人数', 'integer'],
    ])
    expect(existsSync(join(dir, 'out.parquet'))).toBe(true)
  })

  it('says every reason a sheet is not a plain table, the first as the reason', async () => {
    const rows = [
      [{ s: 0 }, { s: 1 }],
      [{ s: 0 }, 2024],
      ...Array.from({ length: 12 }, (_, i) => [i, i]),
    ]
    const result = await interpret(
      await xlsxBuffer({ shared: shared('a', 'b'), sheets: { 1: rows } })
    )

    expect(result.schema).toEqual({ rowCount: 0, columns: [] })
    expect(result.reason).toBe('multi-row-header')
    expect(result.reasons).toEqual(['multi-row-header'])
    expect(existsSync(join(dir, 'out.parquet'))).toBe(false)
  })

  it('reads a plain XLS sheet the same way', async () => {
    const cells = [
      cell.labelSst(0, 0, 0),
      cell.labelSst(0, 1, 1),
      ...Array.from({ length: 12 }, (_, i) => [
        cell.label(i + 1, 0, `地区${i}`),
        cell.number(i + 1, 1, i * 1.5),
      ]).flat(),
    ]
    const xls = xlsBuffer({
      sheets: [{ name: '一覧', cells }],
      sst: biff(0x00fc, sstData(['地区', '値'])),
    })
    const result = await interpret(xls, 'book.xls')

    expect(result.schema.rowCount).toBe(12)
    expect(result.schema.columns.map((c) => [c.name, c.type])).toEqual([
      ['地区', 'string'],
      ['値', 'float'],
    ])
  })

  it('reads a date as a date', async () => {
    const xls = xlsBuffer({
      globals: [layoutRecord.xf(0), layoutRecord.xf(14), layoutRecord.format(14, 'yyyy/m/d')],
      sheets: [
        {
          name: 'd',
          cells: [
            cell.label(0, 0, '日'),
            cell.label(0, 1, '件数'),
            ...Array.from({ length: 12 }, (_, i) => [
              cell.number(i + 1, 0, 45383 + i, 1),
              cell.number(i + 1, 1, i),
            ]).flat(),
          ],
        },
      ],
    })
    const result = await interpret(xls, 'book.xls')

    expect(result.schema.columns.map((c) => c.type)).toEqual(['date', 'integer'])
  })

  it('reads a workbook published as .xls whose bytes are an XLSX', async () => {
    const result = await interpret(await plainXlsx(), 'book.xls')
    expect(result.schema.rowCount).toBe(12)
  })

  it('says an encrypted workbook is one, rather than failing', async () => {
    const xls = xlsBuffer({
      globals: [biff(0x002f, Buffer.alloc(6))],
      sheets: [{ name: 's', cells: [] }],
    })
    expect(await interpret(xls, 'book.xls')).toEqual({
      schema: { rowCount: 0, columns: [] },
      reason: 'encrypted',
      reasons: ['encrypted'],
    })
  })
})
