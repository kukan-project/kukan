import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { xlsGrid } from '@/pipeline/interpret/table/xls-grid'
import { collectGrid, type ReadSheet } from '../../../test-helpers/grid'
import {
  cell,
  chartSubstream,
  layoutRecord as L,
  rkDouble,
  rkInt,
  sstData,
  biff,
  xlsBuffer,
} from '../../../test-helpers/legacy-office'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xls-grid-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function read(opts: Parameters<typeof xlsBuffer>[0]): Promise<ReadSheet[]> {
  const path = join(dir, 'book.xls')
  await writeFile(path, xlsBuffer(opts))
  return collectGrid(xlsGrid(path))
}

/** XF 0 plain, then the ones a test names. */
const xfs = (...extra: Buffer[]) => [L.xf(0), ...extra]

describe('cells', () => {
  it('reads each kind of cell record at its own column', async () => {
    const [sheet] = await read({
      sst: biff(0x00fc, sstData(['name', '東京'])),
      sheets: [
        {
          name: 'data',
          cells: [
            cell.labelSst(0, 0, 0),
            cell.label(0, 2, 'label'),
            cell.number(1, 0, 1.25),
            cell.rk(1, 1, rkInt(7)),
            cell.mulrk(1, 2, [rkInt(1), rkDouble(0.25)]),
            cell.boolerr(2, 0, 1, false),
            cell.boolerr(2, 1, 0x07, true),
            cell.labelSst(2, 3, 1),
          ],
        },
      ],
    })
    expect(sheet!.rows).toEqual([
      {
        row: 1,
        cells: [
          { col: 1, kind: 'text', value: 'name' },
          { col: 3, kind: 'text', value: 'label' },
        ],
      },
      {
        row: 2,
        cells: [
          { col: 1, kind: 'number', value: '1.25' },
          { col: 2, kind: 'number', value: '7' },
          { col: 3, kind: 'number', value: '1' },
          { col: 4, kind: 'number', value: '0.25' },
        ],
      },
      {
        row: 3,
        cells: [
          { col: 1, kind: 'boolean', value: 'true' },
          { col: 2, kind: 'error', value: '#DIV/0!' },
          { col: 4, kind: 'text', value: '東京' },
        ],
      },
    ])
  })

  it('finds a string result past the shared formula a formula is defined by', async () => {
    const shared = cell.formula(0, 0, 'shared')
    const formula = shared.subarray(0, shared.length - (4 + 3 + 6))
    const string = shared.subarray(formula.length)
    const [sheet] = await read({
      sheets: [{ name: 'f', cells: [formula, biff(0x04bc, Buffer.alloc(10)), string] }],
    })
    expect(sheet!.rows[0]!.cells).toEqual([
      { col: 1, kind: 'text', value: 'shared', formula: true },
    ])
    expect(sheet!.layout.uncachedFormulas).toBe(0)
  })

  it('reads a formula by its cached result, and counts one whose string never came', async () => {
    const stringFormula = cell.formula(0, 4, 'never')
    const [sheet] = await read({
      sheets: [
        {
          name: 'f',
          cells: [
            cell.formula(0, 0, 7),
            cell.formula(0, 1, 'seven'),
            cell.formula(0, 2, true),
            cell.formula(0, 3, { error: 0x2a }),
            // The formula record alone: its STRING is cut off
            stringFormula.subarray(0, stringFormula.length - (4 + 3 + 5)),
            cell.number(1, 0, 1),
          ],
        },
      ],
    })
    expect(sheet!.rows[0]!.cells).toEqual([
      { col: 1, kind: 'number', value: '7', formula: true },
      { col: 2, kind: 'text', value: 'seven', formula: true },
      { col: 3, kind: 'boolean', value: 'true', formula: true },
      { col: 4, kind: 'error', value: '#N/A', formula: true },
    ])
    expect(sheet!.layout.uncachedFormulas).toBe(1)
  })
})

describe('dates', () => {
  it('writes a date by its format, built in or the workbook’s own', async () => {
    const [sheet] = await read({
      globals: [
        L.format(176, '[$-411]ggge"年"m"月"d"日"'),
        ...xfs(L.xf(14), L.xf(176), L.xf(20), L.xf(46), L.xf(34)),
      ],
      sheets: [
        {
          name: 'd',
          cells: [
            cell.number(0, 0, 45383, 1),
            cell.number(0, 1, 45383, 2),
            cell.number(0, 2, 45383.5, 3),
            cell.number(0, 3, 1.5, 4),
            cell.number(0, 4, 0.375, 5),
            cell.number(0, 5, 45383, 5),
            cell.number(0, 6, 45383, 0),
          ],
        },
      ],
    })
    expect(sheet!.rows[0]!.cells.map((c) => [c.kind, c.value])).toEqual([
      ['date', '2024-04-01'],
      ['date', '2024-04-01'],
      ['date', '12:00:00'],
      ['number', '1.5'],
      ['date', '09:00:00'],
      ['date', '2024-04-01'],
      ['number', '45383'],
    ])
  })

  it('counts dates from 1904 where the workbook says so', async () => {
    const [sheet] = await read({
      globals: [L.datemode1904(), ...xfs(L.xf(14))],
      sheets: [{ name: 'd', cells: [cell.number(0, 0, 1, 1)] }],
    })
    expect(sheet!.rows[0]!.cells[0]!.value).toBe('1904-01-02')
  })
})

describe('layout', () => {
  it('reads merges, frozen panes, print titles and what is hidden', async () => {
    const sheets = await read({
      globals: [L.printTitles(1, { rows: [2, 3] }), L.printTitles(2, { columns: [0, 1] })],
      sheets: [
        {
          name: 'a',
          cells: [
            L.colinfo(2, 3, true),
            L.row(1, true),
            cell.number(0, 0, 1),
            cell.number(1, 0, 2),
            L.window2(true),
            L.pane(1, 3),
            L.mergedcells([
              [0, 0, 1, 3],
              [4, 6, 0, 0],
            ]),
          ],
        },
        { name: 'b', hidden: true, cells: [cell.number(0, 0, 1), L.window2(false), L.pane(2, 2)] },
      ],
    })
    expect(
      sheets.map(({ sheet, name, hidden, printTitles }) => ({ sheet, name, hidden, printTitles }))
    ).toEqual([
      { sheet: 1, name: 'a', hidden: false, printTitles: { rows: [3, 4] } },
      { sheet: 2, name: 'b', hidden: true, printTitles: { columns: [1, 2] } },
    ])
    const [a, b] = sheets
    expect(a!.rows.map((r) => [r.row, r.hidden])).toEqual([
      [1, undefined],
      [2, true],
    ])
    expect(a!.layout).toEqual({
      merges: [
        { top: 1, bottom: 1, left: 2, right: 4 },
        { top: 5, bottom: 7, left: 1, right: 1 },
      ],
      hiddenColumns: [[3, 4]],
      hiddenRows: [2],
      hiddenRowCount: 1,
      frozen: { rows: 3, columns: 1 },
      uncachedFormulas: 0,
    })
    // A split that is not frozen says nothing of a header
    expect(b!.layout.frozen).toBeUndefined()
  })

  it('leaves out a chart sheet, and a chart drawn on a sheet', async () => {
    const sheets = await read({
      sheets: [
        { name: 'chart' },
        { name: 's', cells: [cell.number(0, 0, 1), chartSubstream([cell.number(5, 5, 9)])] },
      ],
    })
    expect(sheets.map((s) => [s.sheet, s.name, s.rows.length])).toEqual([[2, 's', 1]])
  })
})

describe('borders', () => {
  it('gives the sides drawn on a cell, on empty cells and rows of them too', async () => {
    // left thin, right thin, top medium, bottom double
    const box = L.xf(0, [1, 1, 2, 6])
    const [sheet] = await read({
      globals: xfs(box, L.xf(0, [7, 13, 0, 0])),
      sheets: [
        {
          name: 'b',
          cells: [
            cell.number(0, 0, 1, 1),
            cell.blank(0, 1, 1),
            cell.number(0, 2, 2),
            cell.mulblank(1, 0, [1, 0, 2]),
          ],
        },
      ],
    })
    const sides = { top: 'medium', left: 'thin', bottom: 'double', right: 'thin' }
    expect(sheet!.rows).toEqual([
      {
        row: 1,
        cells: [
          { col: 1, kind: 'number', value: '1' },
          { col: 3, kind: 'number', value: '2' },
        ],
        borders: [
          { col: 1, ...sides },
          { col: 2, ...sides },
        ],
      },
      {
        row: 2,
        cells: [],
        borders: [
          { col: 1, ...sides },
          { col: 3, left: 'hair', right: 'slantDashDot' },
        ],
      },
    ])
  })

  it('reads a BIFF5 format’s lines, three bits a side', async () => {
    // Bottom (thick) among the fill's bits; top (thin), left (hair), right (double) after
    const xf5 = Buffer.alloc(16)
    xf5.writeUInt32LE((5 << 22) >>> 0, 8)
    xf5.writeUInt32LE(1 | (7 << 3) | (6 << 6), 12)
    const [sheet] = await read({
      biff5: true,
      globals: [biff(0x00e0, Buffer.alloc(16)), biff(0x00e0, xf5)],
      sheets: [{ name: Buffer.from('s'), cells: [cell.blank(0, 0, 1)] }],
    })
    expect(sheet!.rows[0]!.borders).toEqual([
      { col: 1, top: 'thin', left: 'hair', bottom: 'thick', right: 'double' },
    ])
  })

  describe('of cells written nothing for', () => {
    const box = { top: 'thin', left: 'thin', bottom: 'thin', right: 'thin' }
    const under = { bottom: 'thick' }
    // XF 1 a thin box, XF 2 a thick bottom
    const globals = xfs(L.xf(0, [1, 1, 1, 1]), L.xf(0, [0, 0, 0, 5]))

    it('draws the row’s default, else the column’s, inside the used range', async () => {
      const [sheet] = await read({
        globals,
        sheets: [
          {
            name: 'd',
            cells: [
              L.colinfo(1, 1, false, 2),
              // Past the used range: no line there
              L.colinfo(3, 4, false, 1),
              L.dimensions(0, 4, 0, 2),
              L.row(1, false, 1),
              L.row(3, false, 1),
              cell.number(0, 0, 1),
              // A cell of its own keeps its own format, though it draws nothing
              cell.number(1, 0, 2),
              cell.number(2, 0, 3),
            ],
          },
        ],
      })
      expect(sheet!.rows).toEqual([
        {
          row: 1,
          cells: [{ col: 1, kind: 'number', value: '1' }],
          borders: [{ col: 2, ...under }],
        },
        {
          row: 2,
          cells: [{ col: 1, kind: 'number', value: '2' }],
          // The row's default over the column's
          borders: [
            { col: 2, ...box },
            { col: 3, ...box },
          ],
        },
        {
          row: 3,
          cells: [{ col: 1, kind: 'number', value: '3' }],
          borders: [{ col: 2, ...under }],
        },
        // A row of no cells, by its own default
        {
          row: 4,
          cells: [],
          borders: [
            { col: 1, ...box },
            { col: 2, ...box },
            { col: 3, ...box },
          ],
        },
        // A row the file has nothing of, by its column's default
        { row: 5, cells: [], borders: [{ col: 2, ...under }] },
      ])
    })

    it('keeps to the cells written where no used range is given', async () => {
      const [sheet] = await read({
        globals,
        sheets: [
          {
            name: 'd',
            cells: [
              L.colinfo(0, 9, false, 2),
              L.row(1, false, 1),
              L.row(5, false, 1),
              cell.number(0, 0, 1),
              cell.number(0, 2, 2),
              cell.number(2, 1, 3),
            ],
          },
        ],
      })
      expect(sheet!.rows.map((r) => [r.row, r.borders?.map((b) => b.col)])).toEqual([
        [1, [2]],
        [2, [1, 2, 3]],
        [3, [1, 3]],
      ])
    })

    it('reads a BIFF5 used range, its rows 16-bit', async () => {
      const xf5 = Buffer.alloc(16)
      xf5.writeUInt32LE((5 << 22) >>> 0, 8)
      const [sheet] = await read({
        biff5: true,
        globals: [biff(0x00e0, Buffer.alloc(16)), biff(0x00e0, xf5)],
        sheets: [
          {
            name: Buffer.from('s'),
            cells: [
              L.colinfo(0, 0, false, 1),
              L.dimensions(0, 2, 0, 1, true),
              cell.number(0, 1, 1),
            ],
          },
        ],
      })
      expect(sheet!.rows.map((r) => [r.row, r.borders])).toEqual([
        [1, [{ col: 1, ...under }]],
        [2, [{ col: 1, ...under }]],
        [3, [{ col: 1, ...under }]],
      ])
    })
  })
})
