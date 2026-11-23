/**
 * An XLS workbook (BIFF8, and BIFF5) as the same grids of cells `xlsxGrid`
 * gives for XLSX: each cell's column, kind and raw value, and what the sheet
 * says of its layout — merged ranges, hidden rows and columns, frozen panes,
 * print titles, and the borders drawn on its cells (ADR-057). XLS has no
 * autofilter range a table reads by, and its Excel tables are not read.
 */

import { readFile } from 'node:fs/promises'
import {
  readXlsWorkbook,
  sheetCells,
  type BiffRecord,
  type XlsWorkbook,
} from '../document/legacy/xls'
import {
  addHiddenRow,
  addMerge,
  DefaultBorders,
  formatKinds,
  gridSheet,
  numericCell,
  type BorderSides,
  type BorderStyle,
  type CellBorder,
  type FormatKind,
  type GridCell,
  type GridRow,
  type GridSheet,
  type SheetLayout,
} from './grid'

const FORMAT = 0x041e
const XF = 0x00e0
const DATEMODE = 0x0022
const NAME = 0x0018
const ROW = 0x0208
const COLINFO = 0x007d
const MERGEDCELLS = 0x00e5
const WINDOW2 = 0x023e
const PANE = 0x0041
const DIMENSIONS = 0x0200

/** A built-in name's one character: the rows and columns repeated on every printed page. */
const PRINT_TITLES = 0x07

/** Line styles as XLS numbers them, from 1. */
const LINE_STYLES: BorderStyle[] = [
  'thin',
  'medium',
  'dashed',
  'dotted',
  'thick',
  'double',
  'hair',
  'mediumDashed',
  'dashDot',
  'mediumDashDot',
  'dashDotDot',
  'mediumDashDotDot',
  'slantDashDot',
]

function lineStyle(n: number): BorderStyle | undefined {
  // A style this does not know is still a line
  return n === 0 ? undefined : (LINE_STYLES[n - 1] ?? 'thin')
}

/** What the globals say of the cell formats and the printed titles. */
interface Globals {
  date1904: boolean
  /** For each XF, its number format's number and its border. */
  xfs: { format: number; border?: BorderSides }[]
  /** What each number format shows, by its number. */
  dateKind: (format: number) => FormatKind | undefined
  /** By 1-based tab. */
  printTitles: Map<number, NonNullable<GridSheet['printTitles']>>
}

/**
 * The workbook's worksheets in tab order. A sheet's rows are read as they are
 * iterated: read them before asking for the next sheet.
 */
export async function* xlsGrid(filePath: string): AsyncGenerator<GridSheet> {
  const { book, globals } = await readWorkbook(filePath)
  for (const entry of book.sheets) {
    const titles = globals.printTitles.get(entry.sheet)
    yield gridSheet(
      {
        sheet: entry.sheet,
        name: entry.name,
        hidden: entry.hidden,
        ...(titles && { printTitles: titles }),
      },
      (layout) => sheetGrid(book, entry.offset, globals, layout)
    )
  }
}

/** The workbook and its globals, read; the file's bytes are not held past it. */
async function readWorkbook(filePath: string): Promise<{ book: XlsWorkbook; globals: Globals }> {
  const book = readXlsWorkbook(await readFile(filePath))
  return { book, globals: readGlobals(book) }
}

function readGlobals({ globals: records, biff8, text }: XlsWorkbook): Globals {
  let date1904 = false
  const codes = new Map<number, string>()
  const xfs: Globals['xfs'] = []
  const titles: Globals['printTitles'] = new Map()
  for (const record of records) {
    const { data } = record
    if (record.type === DATEMODE) date1904 = data.readUInt16LE(0) === 1
    else if (record.type === FORMAT) {
      codes.set(data.readUInt16LE(0), biff8 ? text.long(record, 2) : text.short(data.subarray(2)))
    } else if (record.type === XF) {
      const border = biff8 ? biff8Border(data) : biff5Border(data)
      xfs.push({ format: data.readUInt16LE(2), ...(border && { border }) })
    } else if (record.type === NAME) {
      const name = printTitles(data, biff8)
      if (name) titles.set(name.tab, name.spans)
    }
  }
  return { date1904, xfs, dateKind: formatKinds(codes), printTitles: titles }
}

function sides(top: number, left: number, bottom: number, right: number): BorderSides | undefined {
  const border: BorderSides = {}
  const put = (side: keyof BorderSides, n: number) => {
    const style = lineStyle(n)
    if (style) border[side] = style
  }
  put('top', top)
  put('left', left)
  put('bottom', bottom)
  put('right', right)
  return Object.keys(border).length > 0 ? border : undefined
}

/** BIFF8: four bits a side, left, right, top, bottom. */
function biff8Border(data: Buffer): BorderSides | undefined {
  if (data.length < 12) return undefined
  const lines = data.readUInt16LE(10)
  return sides((lines >> 8) & 0x0f, lines & 0x0f, (lines >> 12) & 0x0f, (lines >> 4) & 0x0f)
}

/** BIFF5: three bits a side, the bottom among the fill's bits and the others after. */
function biff5Border(data: Buffer): BorderSides | undefined {
  if (data.length < 16) return undefined
  const fill = data.readUInt32LE(8)
  const lines = data.readUInt32LE(12)
  return sides(lines & 0x07, (lines >> 3) & 0x07, (fill >> 22) & 0x07, (lines >> 6) & 0x07)
}

/**
 * A built-in Print_Titles name: the sheet it is for, and its row and column
 * spans, from the 3-D areas of its formula.
 */
function printTitles(
  data: Buffer,
  biff8: boolean
): { tab: number; spans: NonNullable<GridSheet['printTitles']> } | undefined {
  if (data.length < 15 || (data.readUInt16LE(0) & 0x0020) === 0) return undefined
  const nameLength = data[3]
  const formulaLength = data.readUInt16LE(4)
  const tab = data.readUInt16LE(8)
  let at = 14
  let char: number
  if (biff8) {
    const wide = (data[at] & 0x01) !== 0
    at++
    char = wide ? data.readUInt16LE(at) : data[at]
    at += nameLength * (wide ? 2 : 1)
  } else {
    char = data[at]
    at += nameLength
  }
  if (char !== PRINT_TITLES || tab === 0) return undefined
  const end = Math.min(data.length, at + formulaLength)
  const spans: NonNullable<GridSheet['printTitles']> = {}
  const maxRow = biff8 ? 0xffff : 0x3fff
  while (at < end) {
    const ptg = data[at]
    // A memory area wraps the union of areas; the union says nothing of its own
    if (ptg === 0x29 || ptg === 0x49 || ptg === 0x69) at += 3
    else if (ptg === 0x10) at += 1
    else if (ptg === 0x3b || ptg === 0x5b || ptg === 0x7b) {
      let rows: [number, number]
      let cols: [number, number]
      if (biff8) {
        if (at + 11 > end) break
        rows = [data.readUInt16LE(at + 3), data.readUInt16LE(at + 5)]
        cols = [data.readUInt16LE(at + 7) & 0x3fff, data.readUInt16LE(at + 9) & 0x3fff]
        at += 11
      } else {
        if (at + 21 > end) break
        rows = [data.readUInt16LE(at + 15) & 0x3fff, data.readUInt16LE(at + 17) & 0x3fff]
        cols = [data[at + 19], data[at + 20]]
        at += 21
      }
      if (cols[0] === 0 && cols[1] >= 0xff) spans.rows = [rows[0] + 1, rows[1] + 1]
      else if (rows[0] === 0 && rows[1] >= maxRow) spans.columns = [cols[0] + 1, cols[1] + 1]
    } else break
  }
  return spans.rows || spans.columns ? { tab, spans } : undefined
}

/**
 * The rows of a worksheet, a row at a time as its cells come: a writer puts a
 * row's cells together, a block of rows in order. A cell of a row already
 * given, from one that did not, comes as a row of its own.
 */
function* sheetGrid(
  book: XlsWorkbook,
  offset: number,
  globals: Globals,
  layout: SheetLayout
): Generator<GridRow> {
  const hidden = new Set<number>()
  const defaults = new DefaultBorders()
  let row = -1
  let cells = new Map<number, GridCell>()
  let borders = new Map<number, CellBorder>()
  let records = new Set<number>()
  const close = (): GridRow | undefined => {
    if (row < 0) return undefined
    const byCol = <T>(m: Map<number, T>) =>
      [...m.entries()].sort(([a], [b]) => a - b).map(([, v]) => v)
    const drawn = defaults.fill(row + 1, records, byCol(borders))
    const closed: GridRow | undefined =
      cells.size === 0 && drawn.length === 0
        ? undefined
        : {
            row: row + 1,
            ...(hidden.has(row) && { hidden: true as const }),
            cells: byCol(cells),
            ...(drawn.length > 0 && { borders: drawn }),
          }
    cells = new Map()
    borders = new Map()
    records = new Set()
    return closed
  }
  /** Rows the file writes no cell for, as their defaults draw them. */
  function* gap(rows: Iterable<{ row: number; borders: CellBorder[] }>): Generator<GridRow> {
    for (const { row: r, borders: drawn } of rows) {
      yield {
        row: r,
        ...(hidden.has(r - 1) && { hidden: true as const }),
        cells: [],
        borders: drawn,
      }
    }
  }

  let frozen = false
  for (const event of sheetCells(book, offset)) {
    if (event.kind === 'record') {
      readLayout(event.record)
      continue
    }
    const col = event.col + 1
    // Before the rows ahead of it are filled, as where no used range is given they reach to it
    defaults.record(event.row + 1, col)
    if (event.row !== row) {
      const closed = close()
      if (closed) yield closed
      yield* gap(defaults.gap(event.row + 1))
      row = event.row
    }
    records.add(col)
    const xf = globals.xfs[event.xf]
    // The border of a cell's format, empty cells' included
    if (xf?.border) borders.set(event.col, { col, ...xf.border })
    let cell: GridCell | undefined
    switch (event.kind) {
      case 'text':
      case 'error':
        if (event.value) cell = { col, kind: event.kind, value: event.value }
        break
      case 'boolean':
        cell = { col, kind: 'boolean', value: event.value ? 'true' : 'false' }
        break
      case 'number':
        cell = numericCell(col, event.value, xf && globals.dateKind(xf.format), globals.date1904)
        break
      case 'uncached':
        // Nothing is cached: the cell has its format and no value
        layout.uncachedFormulas++
        break
    }
    if (cell) {
      if ('formula' in event && event.formula) cell.formula = true
      cells.set(event.col, cell)
    }
  }
  const last = close()
  if (last) yield last
  yield* gap(defaults.rest())

  function readLayout({ type, data }: BiffRecord): void {
    switch (type) {
      case ROW: {
        // The ROW records of a block come before its cells
        if (data.length < 14) break
        const r = data.readUInt16LE(0)
        const options = data.readUInt16LE(12)
        if ((options & 0x0020) !== 0) {
          hidden.add(r)
          addHiddenRow(layout, r + 1)
        }
        // fGhostDirty: the row has a default format, its XF in the low 12 bits after
        if ((options & 0x0080) !== 0 && data.length >= 16) {
          defaults.row(r + 1, globals.xfs[data.readUInt16LE(14) & 0x0fff]?.border ?? null)
        }
        break
      }
      case COLINFO:
        if (data.length < 10) break
        if ((data.readUInt16LE(8) & 0x0001) !== 0) {
          layout.hiddenColumns.push([data.readUInt16LE(0) + 1, data.readUInt16LE(2) + 1])
        }
        defaults.column(
          data.readUInt16LE(0) + 1,
          data.readUInt16LE(2) + 1,
          globals.xfs[data.readUInt16LE(6)]?.border
        )
        break
      case DIMENSIONS:
        // The used range, its last row and column one past: rows are 32-bit in BIFF8
        if (book.biff8 && data.length >= 12) {
          defaults.usedRange({
            top: data.readUInt32LE(0) + 1,
            bottom: data.readUInt32LE(4),
            left: data.readUInt16LE(8) + 1,
            right: data.readUInt16LE(10),
          })
        } else if (!book.biff8 && data.length >= 8) {
          defaults.usedRange({
            top: data.readUInt16LE(0) + 1,
            bottom: data.readUInt16LE(2),
            left: data.readUInt16LE(4) + 1,
            right: data.readUInt16LE(6),
          })
        }
        break
      case MERGEDCELLS: {
        const count = Math.min(data.readUInt16LE(0), Math.floor((data.length - 2) / 8))
        for (let i = 0; i < count; i++) {
          const base = 2 + i * 8
          addMerge(layout, {
            top: data.readUInt16LE(base) + 1,
            bottom: data.readUInt16LE(base + 2) + 1,
            left: data.readUInt16LE(base + 4) + 1,
            right: data.readUInt16LE(base + 6) + 1,
          })
        }
        break
      }
      case WINDOW2:
        // A frozen pane's PANE comes after; a split that is not frozen says nothing of a header
        frozen = data.length >= 2 && (data.readUInt16LE(0) & 0x0008) !== 0
        break
      case PANE:
        if (frozen && data.length >= 4) {
          layout.frozen = { rows: data.readUInt16LE(2), columns: data.readUInt16LE(0) }
        }
        break
    }
  }
}
