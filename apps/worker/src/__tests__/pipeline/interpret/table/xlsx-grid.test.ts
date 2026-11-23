import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dateKindOf,
  parseRange,
  printTitleSpans,
  serialToIso,
  xlsxGrid,
  type GridRow,
  type GridSheet,
  type SheetLayout,
} from '@/pipeline/interpret/table/xlsx-grid'
import { xlsxBuffer } from '../../../test-helpers/xlsx'

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xlsx-grid-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

type Read = Omit<GridSheet, 'rows' | 'layout'> & { rows: GridRow[]; layout: SheetLayout }

async function read(opts: Parameters<typeof xlsxBuffer>[0]): Promise<Read[]> {
  const path = join(dir, 'book.xlsx')
  await writeFile(path, await xlsxBuffer(opts))
  const sheets: Read[] = []
  for await (const { rows: stream, layout, ...sheet } of xlsxGrid(path)) {
    const rows: GridRow[] = []
    for await (const row of stream) rows.push(row)
    sheets.push({ ...sheet, rows, layout: layout() })
  }
  return sheets
}

function sheetXml(body: string, before = '', after = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet ${NS}>${before}<sheetData>${body}</sheetData>${after}</worksheet>`
}

function stylesXml(numFmts: Record<number, string>, cellXfs: number[]): string {
  const formats = Object.entries(numFmts)
    .map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code}"/>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><styleSheet ${NS}><numFmts>${formats}</numFmts><cellStyleXfs><xf numFmtId="14"/></cellStyleXfs><cellXfs>${cellXfs
    .map((id) => `<xf numFmtId="${id}"/>`)
    .join('')}</cellXfs></styleSheet>`
}

describe('cells', () => {
  it('keeps each cell at its own column, leaving out the empty ones', async () => {
    const [sheet] = await read({
      shared: ['<si><t>name</t></si>', '<si><t>東京</t><rPh><t>トウキョウ</t></rPh></si>'],
      sheets: {},
      raw: {
        1: sheetXml(
          '<row r="2"><c r="B2" t="s"><v>0</v></c><c r="D2" t="s"><v>1</v></c></row>' +
            '<row r="5"><c r="A5"><v>1234.5</v></c><c r="C5" s="1"/><c r="E5" t="inlineStr"><is><t>x</t></is></c></row>'
        ),
      },
    })
    expect(sheet!.rows).toEqual([
      {
        row: 2,
        cells: [
          { col: 2, kind: 'text', value: 'name' },
          { col: 4, kind: 'text', value: '東京' },
        ],
      },
      {
        row: 5,
        cells: [
          { col: 1, kind: 'number', value: '1234.5' },
          { col: 5, kind: 'text', value: 'x' },
        ],
      },
    ])
  })

  it('counts columns and rows from the last where a writer left the references out', async () => {
    const [sheet] = await read({ sheets: { 1: [[1, { empty: true }, 3], [], [4]] } })
    expect(sheet!.rows.map(({ row, cells }) => [row, cells.map((c) => c.col)])).toEqual([
      [1, [1, 3]],
      [3, [1]],
    ])
  })

  it('reads booleans, errors and a formula by its cached result', async () => {
    const [sheet] = await read({
      sheets: {},
      raw: {
        1: sheetXml(
          '<row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="e"><v>#DIV/0!</v></c>' +
            '<c r="C1"><f>SUM(A2:A3)</f><v>7</v></c><c r="D1" t="str"><f>A1&amp;""</f><v>seven</v></c>' +
            '<c r="E1"><f>NOW()</f></c><c r="F1"><f>A2*2</f><v/></c>' +
            '<c r="G1" t="str"><f>A2&amp;""</f><v></v></c></row>'
        ),
      },
    })
    expect(sheet!.rows[0]!.cells).toEqual([
      { col: 1, kind: 'boolean', value: 'true' },
      { col: 2, kind: 'error', value: '#DIV/0!' },
      { col: 3, kind: 'number', value: '7', formula: true },
      { col: 4, kind: 'text', value: 'seven', formula: true },
    ])
    expect(sheet!.layout.uncachedFormulas).toBe(2)
  })

  it('writes a date by its format, and leaves a number with any other format a number', async () => {
    const [sheet] = await read({
      sheets: {},
      raw: {
        1: sheetXml(
          '<row r="1"><c r="A1" s="1"><v>45383</v></c><c r="B1" s="2"><v>45383</v></c>' +
            '<c r="C1" s="3"><v>0.375</v></c><c r="D1" s="1"><v>45383.5</v></c>' +
            '<c r="E1" s="4"><v>45383</v></c><c r="F1" s="3"><v>1.5</v></c><c r="G1" t="d"><v>2024-04-01</v></c></row>'
        ),
      },
      parts: {
        'xl/styles.xml': stylesXml(
          { 176: '[$-411]ggge&quot;年&quot;m&quot;月&quot;d&quot;日&quot;' },
          [0, 14, 176, 20, 3]
        ),
      },
    })
    expect(sheet!.rows[0]!.cells.map((c) => [c.kind, c.value])).toEqual([
      ['date', '2024-04-01'],
      ['date', '2024-04-01'],
      ['date', '09:00:00'],
      ['date', '2024-04-01T12:00:00'],
      ['number', '45383'],
      ['date', '12:00:00'],
      ['date', '2024-04-01'],
    ])
  })

  it('reads the built-in CJK formats: 32 as a time, 34 by its value', async () => {
    // 32 is h"時"mm"分" in every CJK Excel; 34 is yyyy"年"m"月" in a Japanese one and a time in a Chinese one
    const [sheet] = await read({
      sheets: {},
      raw: {
        1: sheetXml(
          '<row r="1"><c r="A1" s="1"><v>0.375</v></c><c r="B1" s="2"><v>45383</v></c>' +
            '<c r="C1" s="2"><v>0.375</v></c><c r="D1" s="3"><v>45383</v></c></row>'
        ),
      },
      parts: { 'xl/styles.xml': stylesXml({}, [0, 32, 34, 31]) },
    })
    expect(sheet!.rows[0]!.cells.map((c) => [c.kind, c.value])).toEqual([
      ['date', '09:00:00'],
      ['date', '2024-04-01'],
      ['date', '09:00:00'],
      ['date', '2024-04-01'],
    ])
  })

  it('counts dates from 1904 where the workbook says so', async () => {
    const [sheet] = await read({
      sheets: {},
      raw: { 1: sheetXml('<row r="1"><c r="A1" s="1"><v>1</v></c></row>') },
      parts: {
        'xl/styles.xml': stylesXml({}, [0, 14]),
        'xl/workbook.xml': `<workbook ${NS}><workbookPr date1904="1"/></workbook>`,
      },
    })
    expect(sheet!.rows[0]!.cells[0]!.value).toBe('1904-01-02')
  })
})

describe('layout', () => {
  it('reads merges, frozen panes, the autofilter and what is hidden', async () => {
    const [sheet] = await read({
      sheets: {},
      raw: {
        1: sheetXml(
          '<row r="1"><c r="A1"><v>1</v></c></row><row r="2" hidden="1"><c r="A2"><v>2</v></c></row>',
          '<sheetViews><sheetView><pane xSplit="1" ySplit="3" topLeftCell="B4" state="frozen"/></sheetView></sheetViews>' +
            '<cols><col min="3" max="5" hidden="1"/><col min="7" max="7"/></cols>',
          '<autoFilter ref="A3:F20"/><mergeCells><mergeCell ref="A1:F1"/><mergeCell ref="B2:B3"/></mergeCells>'
        ),
      },
    })
    expect(sheet!.layout).toEqual({
      merges: [
        { top: 1, left: 1, bottom: 1, right: 6 },
        { top: 2, left: 2, bottom: 3, right: 2 },
      ],
      hiddenColumns: [[3, 5]],
      hiddenRows: [2],
      hiddenRowCount: 1,
      frozen: { rows: 3, columns: 1 },
      autoFilter: { top: 3, left: 1, bottom: 20, right: 6 },
      uncachedFormulas: 0,
    })
    expect(sheet!.rows[1]).toMatchObject({ row: 2, hidden: true })
  })

  it('does not take a split that is not frozen for a header', async () => {
    const [sheet] = await read({
      sheets: {},
      raw: {
        1: sheetXml('', '<sheetViews><sheetView><pane ySplit="900"/></sheetView></sheetViews>'),
      },
    })
    expect(sheet!.layout.frozen).toBeUndefined()
  })

  it('has no layout before the rows are read', async () => {
    const path = join(dir, 'early.xlsx')
    await writeFile(path, await xlsxBuffer({ sheets: { 1: [[1]] } }))
    for await (const sheet of xlsxGrid(path)) {
      expect(() => sheet.layout()).toThrow()
      for await (const _ of sheet.rows) void _
      expect(sheet.layout().merges).toEqual([])
    }
  })
})

describe('workbook', () => {
  const workbook = `<workbook ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="表" sheetId="1" r:id="rId1"/><sheet name="work" sheetId="2" state="hidden" r:id="rId2"/></sheets><definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">表!$A:$B,表!$1:$3</definedName><definedName name="_xlnm.Print_Area" localSheetId="0">表!$A$1:$H$40</definedName></definedNames></workbook>`
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`

  it('says which sheets are hidden and which rows and columns print on every page', async () => {
    const sheets = await read({
      sheets: { 1: [[1]], 2: [[2]] },
      parts: { 'xl/workbook.xml': workbook, 'xl/_rels/workbook.xml.rels': rels },
    })
    expect(
      sheets.map(({ sheet, name, hidden, printTitles }) => ({ sheet, name, hidden, printTitles }))
    ).toEqual([
      { sheet: 1, name: '表', hidden: false, printTitles: { columns: [1, 2], rows: [1, 3] } },
      { sheet: 2, name: 'work', hidden: true, printTitles: undefined },
    ])
  })
})

describe('borders', () => {
  // cellXfs: 0 plain, 1 → border 1, 2 → border 2, 3 → border 3 (no side drawn)
  const styles = `<?xml version="1.0" encoding="UTF-8"?><styleSheet ${NS}><borders><border><left/><right/><top/><bottom/></border><border><left style="thin"/><right style="thin"/><top style="medium"/><bottom style="double"/><diagonal style="thin"/></border><border><start style="hair"/><end style="futureStyle"/></border><border><left style="none"/></border></borders><cellXfs><xf numFmtId="0"/><xf numFmtId="0" borderId="1"/><xf numFmtId="0" borderId="2"/><xf numFmtId="0" borderId="3"/></cellXfs><dxfs><dxf><border><left style="thick"/></border></dxf></dxfs></styleSheet>`

  it('gives the sides drawn on a cell, on empty cells and empty rows too', async () => {
    const [sheet] = await read({
      sheets: {},
      raw: {
        1: sheetXml(
          '<row r="1"><c r="A1" s="1"><v>1</v></c><c r="B1" s="1"/><c r="C1"><v>2</v></c></row>' +
            '<row r="2"><c r="A2" s="1"/></row>' +
            '<row r="3"><c r="A3" s="3"/></row>'
        ),
      },
      parts: { 'xl/styles.xml': styles },
    })
    const box = { top: 'medium', left: 'thin', bottom: 'double', right: 'thin' }
    expect(sheet!.rows).toEqual([
      {
        row: 1,
        cells: [
          { col: 1, kind: 'number', value: '1' },
          { col: 3, kind: 'number', value: '2' },
        ],
        borders: [
          { col: 1, ...box },
          { col: 2, ...box },
        ],
      },
      { row: 2, cells: [], borders: [{ col: 1, ...box }] },
    ])
  })

  it('reads start and end as left and right, and an unknown style as a line', async () => {
    const [sheet] = await read({
      sheets: {},
      raw: { 1: sheetXml('<row r="1"><c r="B1" s="2"><v>1</v></c></row>') },
      parts: { 'xl/styles.xml': styles },
    })
    expect(sheet!.rows[0]!.borders).toEqual([{ col: 2, left: 'hair', right: 'thin' }])
  })
})

describe('formats and references', () => {
  it.each([
    ['yyyy/m/d', 'date'],
    ['[$-411]ge.m.d;@', 'date'],
    ['[$-F800]dddd\\,\\ mmmm\\ dd\\,\\ yyyy', 'date'],
    ['m"月"', 'date'],
    ['h:mm', 'time'],
    ['[h]:mm:ss', 'duration'],
    ['[mm]:ss', 'duration'],
    ['h:mm AM/PM', 'time'],
    ['#,##0', undefined],
    ['0.00E+00', undefined],
    ['General', undefined],
    ['#,##0;[Red]\\-#,##0', undefined],
    ['0"日"', undefined],
    ['@', undefined],
  ])('%s shows %s', (code, kind) => {
    expect(dateKindOf(code)).toBe(kind)
  })

  it('steps over the 29 February 1900 that Excel counts', () => {
    expect(serialToIso(1, 'date', false)).toBe('1900-01-01')
    expect(serialToIso(59, 'date', false)).toBe('1900-02-28')
    expect(serialToIso(61, 'date', false)).toBe('1900-03-01')
    expect(serialToIso(0.99999999999, 'date', false)).toBe('1900-01-01')
    expect(serialToIso(-1, 'date', false)).toBeUndefined()
    expect(serialToIso(1e9, 'date', false)).toBeUndefined()
  })

  it('keeps the fraction of a second a format can show', () => {
    expect(serialToIso(0.5 / 86_400, 'time', false)).toBe('00:00:00.500')
    expect(serialToIso(45383 + 0.375 + 0.25 / 86_400, 'date', false)).toBe(
      '2024-04-01T09:00:00.250'
    )
    expect(serialToIso(0.375, 'time', false)).toBe('09:00:00')
    expect(serialToIso(0.9999999999, 'duration', false)).toBeUndefined()
  })

  it('reads a time of day off a serial that holds a day, and keeps a long duration a number', () => {
    expect(serialToIso(45383.5, 'time', false)).toBe('12:00:00')
    expect(serialToIso(0.5, 'duration', false)).toBe('12:00:00')
    expect(serialToIso(1.5, 'duration', false)).toBeUndefined()
  })

  it('reads ranges and print titles', () => {
    expect(parseRange('$B$2:$AA$10')).toEqual({ top: 2, left: 2, bottom: 10, right: 27 })
    expect(parseRange('C3')).toEqual({ top: 3, left: 3, bottom: 3, right: 3 })
    expect(parseRange('A:B')).toBeUndefined()
    expect(printTitleSpans("'a,b'!$2:$4")).toEqual({ rows: [2, 4] })
    expect(printTitleSpans('#REF!')).toBeUndefined()
  })
})
