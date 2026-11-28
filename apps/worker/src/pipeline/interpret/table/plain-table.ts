/**
 * Whether a workbook is a plain table: one sheet, one header row, a rectangle
 * of data with no merges, titles and notes only as rows of one cell above and
 * below. Such a workbook is read by rule; any other is left for a person to
 * settle (ADR-057 §決定 3, spec phase-excel-tables §5). When in doubt it is
 * not a plain table: a header read one row off breaks every row.
 *
 * Each sheet is read once as a stream and only what judging needs is kept: per
 * row, its count of values; per run of rows between empty rows ("block"), its
 * counts of values by column and kind, and in full only the rows at its edges
 * — the titles, the header and the row under it at the top, the last row of
 * two values or more and the notes after it at the bottom. The body of the
 * table is whichever block has the most rows of two values or more, unknown
 * until the sheet ends, so the details of two blocks are kept: the best so
 * far and the one being read. Counts over the data rows are the block's
 * counts less the edge rows, which are kept in full. A sheet of a million rows
 * thus takes the memory of its widest rows, not of its cells.
 */

import { NO_VALUE_MARK } from '@kukan/lake'
import type { NoTableReason } from '@kukan/shared'
import { EncryptedWorkbookError } from '../document/legacy/xls'
import type { CellRange, GridCell, GridRow, GridSheet, SheetLayout } from './grid'

/** Why a workbook is not a plain table, in the order the first one is recorded (spec §5.8). */
const PLAIN_TABLE_REASONS = [
  'encrypted',
  'no-table',
  'multiple-sheets',
  'title-or-footer',
  'header-blank',
  'header-duplicate',
  'header-not-text',
  'multi-row-header',
  'merged-cells',
  'not-rectangular',
  'section-rows',
  'multiple-tables',
  'uncached-formulas',
  'too-small',
] as const satisfies readonly NoTableReason[]

/** The reading the rule gives a plain table (spec §3.1, less what only a settled one has). */
export interface PlainTableReading {
  sheet: string
  /** The sheet's place in tab order, 1-based: what the CSV pass finds it by. */
  sheetNumber: number
  /** Top-left of the range, the header included (A1). */
  from: string
  /** Bottom-right of the range (A1). */
  to: string
  headerRows: 1
  /** The header's text, trimmed, one per column. */
  columnNames: string[]
  /** `from` and `to` as numbers, the header's row on top. */
  range: CellRange
}

export type PlainTableJudgment = { reading: PlainTableReading } | { reasons: NoTableReason[] }

/** Sheets with fewer values than this are a cover or a note, not a table (spec §5.1). */
const MIN_SHEET_VALUES = 20
/** A sheet whose rows are this share or more a single text is prose... */
const PROSE_ROW_SHARE = 0.6
/** ...unless it has this many numeric columns. */
const PROSE_MAX_NUMERIC_COLUMNS = 2
/** A column counts as numeric for the above with this many values... */
const NUMERIC_COLUMN_MIN_VALUES = 3
/** ...this share of them numbers or dates (the spike's classification). */
const NUMERIC_COLUMN_SHARE = 0.6
/** A data column this share numbers or dates makes a text in it a header or a note (spec §5.2, §5.4). */
const TYPED_COLUMN_SHARE = 0.9
/** A later row holding this share of the header's names repeats the header (spec §5.5). */
const REPEATED_HEADER_SHARE = 0.8

const NO_VALUE = new RegExp(`^(?:${NO_VALUE_MARK})$`)

type Category = 'number' | 'text' | 'mark' | 'other'

interface ValueCell {
  col: number
  kind: GridCell['kind']
  /** Trimmed. */
  value: string
  category: Category
  /** A text's name as names are compared, worked out once per cell. */
  name?: string
}

interface KeptRow {
  row: number
  cells: ValueCell[]
}

interface ColumnCount {
  number: number
  text: number
  other: number
  mark: number
}

/** A header's names, and how far a later row repeats them. */
interface RepeatTrack {
  /** Each name, with the last row found to hold it: counts a name once per row without a set per row. */
  names: Map<string, number>
  /** Most of the names one later row holds. */
  laterBest: number
  /** Names the header row itself holds twice or more. */
  sameRow: number
}

interface Block {
  top: number
  bottom: number
  /** Rows of two values or more. */
  multiRows: number
  /** Rows of exactly one value. */
  singleRows: number
  columns: Map<number, ColumnCount>
  /** The rows of one value at the top, then the first row of two or more (the header), then the row under it. */
  head: KeptRow[]
  headerAt: number
  /** The last row of two values or more, and the rows of one value after it. */
  tail: KeptRow[]
  repeat?: RepeatTrack
}

type SheetClass = 'empty' | 'not-table' | 'hidden' | 'candidate'

/** What reading one sheet left to judge it by. */
interface SheetScan {
  sheet: number
  name: string
  class: SheetClass
  body?: Block
  /** Other blocks with as many rows of two values or more as the body. */
  bodyTies: number
  /** Blocks with a row of two values or more, the body's included. */
  multiBlocks: number
  /** Merges that touch the body's rows. */
  merges: CellRange[]
  frozenRows?: number
  printTitleRows?: [number, number]
  uncachedFormulas: number
}

/**
 * Whether a workbook is a plain table, and the reading of it if it is. An
 * encrypted workbook is one of the answers, not a failure: its reader throws
 * before the first sheet, and that is the workbook's, not the moment's.
 */
export async function judgePlainTable(
  sheets: AsyncIterable<GridSheet>
): Promise<PlainTableJudgment> {
  let candidate: SheetScan | undefined
  let candidates = 0
  try {
    for await (const sheet of sheets) {
      const scan = await scanSheet(sheet)
      if (scan.class !== 'candidate') continue
      candidates++
      candidate ??= scan
    }
  } catch (err) {
    if (err instanceof EncryptedWorkbookError) return { reasons: ['encrypted'] }
    throw err
  }
  if (!candidate) return { reasons: ['no-table'] }
  if (candidates > 1) return { reasons: ['multiple-sheets'] }
  return judgeSheet(candidate)
}

/** Read a sheet to its end, keeping what judging it needs. */
async function scanSheet(sheet: GridSheet): Promise<SheetScan> {
  const scanner = new SheetScanner()
  if (sheet.hidden) {
    // The stream is still drained: the reader moves on to the next sheet only after it
    for await (const _ of sheet.rows) void _
  } else {
    for await (const row of sheet.rows) scanner.add(row)
  }
  const layout = sheet.layout()
  return scanner.finish(sheet, layout)
}

/** Whether a scanned sheet is a plain table (§5.2–§5.6), with every reason it is not. */
function judgeSheet(scan: SheetScan): PlainTableJudgment {
  const body = scan.body
  if (!body || body.multiRows === 0) return { reasons: ['too-small'] }
  const reasons = new Set<NoTableReason>()
  if (scan.multiBlocks > 1) reasons.add('title-or-footer')
  if (scan.bodyTies > 0) reasons.add('multiple-tables')

  const header = body.head[body.headerAt]!
  const titles = body.head.slice(0, body.headerAt)
  const last = body.tail[0]!
  const notes = body.tail.slice(1)
  const firstData = body.head[body.headerAt + 1]
  const dataRows = last.row - header.row
  const hasData = dataRows > 0 && firstData !== undefined && firstData.row <= last.row

  const data = cloneCounts(body.columns)
  for (const row of [...titles, header, ...notes]) subtract(data, row)

  // The table's columns: the header's and the data's together
  const headerCols = header.cells.map((c) => c.col)
  const dataCols = [...data]
    .filter(([, c]) => c.number + c.text + c.other + c.mark > 0)
    .map(([c]) => c)
  const left = Math.min(...headerCols, ...(hasData ? dataCols : []))
  const right = Math.max(...headerCols, ...(hasData ? dataCols : []))

  // §5.3
  if (header.cells.length < right - left + 1) reasons.add('header-blank')
  // Also by ASCII case: DuckDB takes `ID` and `id` for one column and renames the second
  const names = header.cells.map((c) => asciiLower(c.name ?? compareName(c.value)))
  if (new Set(names).size < names.length) reasons.add('header-duplicate')
  if (header.cells.some((c) => c.kind !== 'text')) reasons.add('header-not-text')

  if (hasData) {
    // §5.2 step 5: a text under a numeric column at the bottom is a note or a total's label
    if (firstData.row < last.row && textUnderTypedColumn(data, last)) reasons.add('title-or-footer')
    // §5.4
    if (firstData.row < last.row && textUnderTypedColumn(data, firstData)) {
      reasons.add('multi-row-header')
    }
    if (scan.merges.some((m) => touchesRows(m, header.row, firstData.row))) {
      reasons.add('multi-row-header')
    }
    // §5.5
    if (scan.merges.some((m) => m.top <= last.row && m.bottom >= firstData.row)) {
      reasons.add('merged-cells')
    }
    const headerLeft = Math.min(...headerCols)
    const headerRight = Math.max(...headerCols)
    if (dataCols.some((c) => c < headerLeft || c > headerRight)) {
      reasons.add('not-rectangular')
    }
    const dataSingles = body.singleRows - titles.length - notes.length
    if (dataSingles > 0) reasons.add('section-rows')
  } else {
    if (scan.merges.some((m) => touchesRows(m, header.row, header.row))) {
      reasons.add('multi-row-header')
    }
  }
  if (scan.frozenRows && scan.frozenRows !== header.row) reasons.add('multi-row-header')
  if (scan.printTitleRows && scan.printTitleRows[1] !== header.row) reasons.add('multi-row-header')
  if (repeatsHeader(body.repeat)) reasons.add('multiple-tables')
  if (scan.uncachedFormulas > 0) reasons.add('uncached-formulas')
  if (right - left + 1 < 2 || !hasData) reasons.add('too-small')

  if (reasons.size > 0) {
    return { reasons: PLAIN_TABLE_REASONS.filter((r: NoTableReason) => reasons.has(r)) }
  }
  return {
    reading: {
      sheet: scan.name,
      sheetNumber: scan.sheet,
      from: `${columnLetters(left)}${header.row}`,
      to: `${columnLetters(right)}${last.row}`,
      headerRows: 1,
      columnNames: header.cells.map((c) => columnName(c.value)),
      range: { top: header.row, left, bottom: last.row, right },
    },
  }
}

class SheetScanner {
  private values = 0
  private valuedRows = 0
  private singleTextRows = 0
  private readonly sheetColumns = new Map<number, { values: number; numbers: number }>()
  private current?: Block
  private best?: Block
  private bestTies = 0
  private multiBlocks = 0
  private lastRow = 0

  add(gridRow: GridRow): void {
    const cells = valueCells(gridRow.cells)
    if (cells.length === 0 || gridRow.row > this.lastRow + 1) this.closeBlock()
    this.lastRow = gridRow.row
    if (cells.length === 0) return

    this.values += cells.length
    this.valuedRows++
    if (cells.length === 1 && cells[0]!.kind === 'text') this.singleTextRows++
    for (const cell of cells) {
      const column = this.sheetColumns.get(cell.col) ?? { values: 0, numbers: 0 }
      column.values++
      if (cell.category === 'number') column.numbers++
      this.sheetColumns.set(cell.col, column)
    }

    const row: KeptRow = { row: gridRow.row, cells }
    for (const block of [this.best, this.current]) {
      if (block?.repeat) trackRepeat(block.repeat, row)
    }
    const block = (this.current ??= newBlock(gridRow.row))
    block.bottom = gridRow.row
    for (const cell of cells) addCount(block.columns, cell)
    const multi = cells.length >= 2
    if (multi) block.multiRows++
    else block.singleRows++

    if (block.headerAt < 0) {
      block.head.push(row)
      if (multi) {
        block.headerAt = block.head.length - 1
        block.repeat = headerRepeat(row)
      }
    } else if (block.head.length === block.headerAt + 1) {
      block.head.push(row)
    }
    if (multi) block.tail = [row]
    else if (block.tail.length > 0) block.tail.push(row)
  }

  finish(sheet: GridSheet, layout: SheetLayout): SheetScan {
    this.closeBlock()
    const base = {
      sheet: sheet.sheet,
      name: sheet.name ?? `Sheet${sheet.sheet}`,
      bodyTies: 0,
      multiBlocks: 0,
      merges: [],
      uncachedFormulas: layout.uncachedFormulas,
    }
    if (this.values === 0) return { ...base, class: sheet.hidden ? 'hidden' : 'empty' }
    if (sheet.hidden) return { ...base, class: 'hidden' }
    if (this.values < MIN_SHEET_VALUES || this.prose()) return { ...base, class: 'not-table' }
    const body = this.best
    return {
      ...base,
      class: 'candidate',
      ...(body && { body }),
      bodyTies: this.bestTies,
      multiBlocks: this.multiBlocks,
      merges: body ? layout.merges.filter((m) => m.top <= body.bottom && m.bottom >= body.top) : [],
      ...(layout.frozen && layout.frozen.rows > 0 && { frozenRows: layout.frozen.rows }),
      ...(sheet.printTitles?.rows && { printTitleRows: sheet.printTitles.rows }),
    }
  }

  private prose(): boolean {
    let numeric = 0
    for (const { values, numbers } of this.sheetColumns.values()) {
      if (values >= NUMERIC_COLUMN_MIN_VALUES && numbers / values >= NUMERIC_COLUMN_SHARE) numeric++
    }
    return (
      this.singleTextRows / this.valuedRows >= PROSE_ROW_SHARE &&
      numeric < PROSE_MAX_NUMERIC_COLUMNS
    )
  }

  private closeBlock(): void {
    const block = this.current
    if (!block) return
    this.current = undefined
    if (block.multiRows > 0) this.multiBlocks++
    if (!this.best || block.multiRows > this.best.multiRows) {
      this.best = block
      this.bestTies = 0
    } else if (block.multiRows === this.best.multiRows && block.multiRows > 0) {
      this.bestTies++
    }
  }
}

function newBlock(top: number): Block {
  return {
    top,
    bottom: top,
    multiRows: 0,
    singleRows: 0,
    columns: new Map(),
    head: [],
    headerAt: -1,
    tail: [],
  }
}

/**
 * The longest text read as a name or as a mark. Every cell that names a shared
 * string is handed the whole string, so what is done to a text here is done
 * once per cell; past any length a heading has, a text is only a text.
 */
const NAME_MAX_CHARS = 1000

function valueCells(cells: GridCell[]): ValueCell[] {
  const out: ValueCell[] = []
  for (const cell of cells) {
    const value = cell.value.trim()
    if (value === '') continue
    out.push({
      col: cell.col,
      kind: cell.kind,
      value,
      category: categoryOf(cell.kind, value),
      ...(cell.kind === 'text' && value.length <= NAME_MAX_CHARS && { name: compareName(value) }),
    })
  }
  return out
}

function categoryOf(kind: GridCell['kind'], value: string): Category {
  if (kind === 'number' || kind === 'date') return 'number'
  if (kind === 'error') return 'mark'
  if (kind === 'boolean') return 'other'
  return value.length <= NAME_MAX_CHARS && NO_VALUE.test(value) ? 'mark' : 'text'
}

function addCount(columns: Map<number, ColumnCount>, cell: ValueCell, by = 1): void {
  let count = columns.get(cell.col)
  if (!count) {
    count = { number: 0, text: 0, other: 0, mark: 0 }
    columns.set(cell.col, count)
  }
  count[cell.category] += by
}

function cloneCounts(columns: Map<number, ColumnCount>): Map<number, ColumnCount> {
  return new Map([...columns].map(([col, count]) => [col, { ...count }]))
}

function subtract(columns: Map<number, ColumnCount>, row: KeptRow): void {
  for (const cell of row.cells) addCount(columns, cell, -1)
}

/**
 * Whether a row has a text in a column the other data rows fill with numbers
 * or dates. A no-value mark is left out of the share: it says nothing of the
 * column's type.
 */
function textUnderTypedColumn(data: Map<number, ColumnCount>, row: KeptRow): boolean {
  return row.cells.some((cell) => {
    if (cell.category !== 'text') return false
    const count = data.get(cell.col)
    if (!count) return false
    const text = count.text - 1
    const total = count.number + text + count.other
    return count.number > 0 && count.number / total >= TYPED_COLUMN_SHARE
  })
}

function touchesRows(merge: CellRange, from: number, to: number): boolean {
  return merge.top <= to && merge.bottom >= from
}

function headerRepeat(header: KeptRow): RepeatTrack {
  const seen = new Map<string, number>()
  for (const { name } of header.cells) {
    if (name !== undefined) seen.set(name, (seen.get(name) ?? 0) + 1)
  }
  return {
    names: new Map([...seen.keys()].map((name) => [name, header.row])),
    laterBest: 0,
    sameRow: [...seen.values()].filter((n) => n > 1).length,
  }
}

function trackRepeat(track: RepeatTrack, row: KeptRow): void {
  let found = 0
  for (const { name } of row.cells) {
    if (name === undefined) continue
    const last = track.names.get(name)
    if (last === undefined || last === row.row) continue
    track.names.set(name, row.row)
    found++
  }
  if (found > track.laterBest) track.laterBest = found
}

/** A header of two names or more whose names a later row, or the header itself further right, holds again. */
function repeatsHeader(track: RepeatTrack | undefined): boolean {
  if (!track || track.names.size < 2) return false
  const share = (n: number) => n / track.names.size >= REPEATED_HEADER_SHARE
  return share(track.laterBest) || share(track.sameRow)
}

/** A header's text as a column name (spec §5.7): trimmed, a line break a space. */
function columnName(text: string): string {
  // Split and trimmed, not `/\s*(?:\r\n|\r|\n)\s*/g`: the pattern retries a run
  // of spaces with no line break after it from each of its characters
  return text
    .split(/\r\n|\r|\n/)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '')
    .join(' ')
}

/** A name as names are compared (spec §5.7): letters, digits and marks folded by NFKC. */
function compareName(text: string): string {
  return columnName(text).normalize('NFKC')
}

const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase())

/** A 1-based column as its letters: 1 → A, 27 → AA. */
export function columnLetters(col: number): string {
  let letters = ''
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters
  }
  return letters
}
