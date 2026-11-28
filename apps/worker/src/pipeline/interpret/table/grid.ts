/**
 * A workbook's sheet as a grid of cells, whatever format it was read from:
 * each row's cells with their column, kind and raw value, and what the sheet
 * says of its layout. Reading a sheet as a table starts from these (ADR-057).
 *
 * Values are raw, not as a number format shows them: `1234`, not `1,234`. Only
 * a date is rewritten, from its serial number to ISO 8601, as a format is all
 * that tells it from a number.
 */

import { LimitError } from '../document/xlsx-package'

/** Merged ranges a sheet may declare: a form drawn on grid paper has thousands. */
const GRID_MAX_MERGES = 200_000

/** Hidden rows listed by number; past this only their count is kept. */
const GRID_MAX_HIDDEN_ROWS = 10_000

/** A rectangle of cells, 1-based and inclusive. */
export interface CellRange {
  top: number
  left: number
  bottom: number
  right: number
}

export type GridCellKind = 'text' | 'number' | 'date' | 'boolean' | 'error'

export interface GridCell {
  /** 1-based column. */
  col: number
  kind: GridCellKind
  /** The raw value; a date or time as ISO 8601. */
  value: string
  /** The value is a formula's cached result. */
  formula?: true
}

export const BORDER_STYLES = [
  'thin',
  'medium',
  'thick',
  'double',
  'hair',
  'dotted',
  'dashed',
  'dashDot',
  'dashDotDot',
  'mediumDashed',
  'mediumDashDot',
  'mediumDashDotDot',
  'slantDashDot',
] as const

/** A border's line, as XLSX names it. */
export type BorderStyle = (typeof BORDER_STYLES)[number]

/** The lines drawn on a cell's sides. */
export interface BorderSides {
  top?: BorderStyle
  left?: BorderStyle
  bottom?: BorderStyle
  right?: BorderStyle
}

export interface CellBorder extends BorderSides {
  /** 1-based column. */
  col: number
}

export interface GridRow {
  /** 1-based row. */
  row: number
  hidden?: true
  /** The cells that hold a value, left to right. */
  cells: GridCell[]
  /**
   * The cells with a border, left to right, one each, empty ones included. A
   * line between two cells may be on either: the bottom of one or the top of
   * the next. A cell the file writes nothing for has its row's default format,
   * or else its column's, as Excel draws it; only inside the sheet's used range
   * (`DefaultBorders`). A row may be here for these alone.
   */
  borders?: CellBorder[]
}

/** What a sheet says of its layout, known once its rows have been read. */
export interface SheetLayout {
  merges: CellRange[]
  /** Hidden columns as inclusive spans. */
  hiddenColumns: [number, number][]
  hiddenRows: number[]
  hiddenRowCount: number
  /** Rows and columns frozen at the top and left. */
  frozen?: { rows: number; columns: number }
  autoFilter?: CellRange
  /** Formulas with no cached result: their cells are not in the rows. */
  uncachedFormulas: number
}

export interface GridSheet {
  /** 1-based, in tab order. */
  sheet: number
  name?: string
  hidden: boolean
  /** Rows and columns repeated on every printed page, as inclusive spans. */
  printTitles?: { rows?: [number, number]; columns?: [number, number] }
  rows: AsyncIterable<GridRow>
  /** The sheet's layout; only after `rows` has been read to its end. */
  layout(): SheetLayout
}

/**
 * A workbook whose sheets can be read more than once, what they share (the
 * shared strings, the styles) decoded on the first read and kept until
 * `close`: judging a sheet and then writing its range reads it twice.
 */
export interface GridWorkbook {
  sheets(): AsyncGenerator<GridSheet>
  close(): Promise<void>
}

/**
 * A sheet whose rows `readRows` gives as it is iterated, filling in the
 * layout it is handed as it goes.
 */
export function gridSheet(
  meta: Omit<GridSheet, 'rows' | 'layout'>,
  readRows: (layout: SheetLayout) => AsyncIterable<GridRow> | Iterable<GridRow>
): GridSheet {
  const layout: SheetLayout = {
    merges: [],
    hiddenColumns: [],
    hiddenRows: [],
    hiddenRowCount: 0,
    uncachedFormulas: 0,
  }
  let done = false
  return {
    ...meta,
    rows: (async function* () {
      yield* readRows(layout)
      done = true
    })(),
    layout() {
      if (!done) throw new Error('A sheet has a layout once its rows are read')
      return layout
    },
  }
}

export function addMerge(layout: SheetLayout, range: CellRange): void {
  if (layout.merges.length >= GRID_MAX_MERGES) {
    throw new LimitError(`A sheet merges over ${GRID_MAX_MERGES} ranges`)
  }
  layout.merges.push(range)
}

/** A hidden row, 1-based. */
export function addHiddenRow(layout: SheetLayout, row: number): void {
  layout.hiddenRowCount++
  if (layout.hiddenRows.length < GRID_MAX_HIDDEN_ROWS) layout.hiddenRows.push(row)
}

/** XLSX's last column; XLS stops at 256. */
const GRID_MAX_COLUMNS = 16_384

/**
 * Cells of a sheet its row and column default formats may give a border; past
 * this they give none. A used range may claim a million rows under a formatted
 * column, every one a row of borders. These only draw the sheet's lines, so
 * they are cut short rather than failing a sheet whose values read fine.
 */
const GRID_MAX_DEFAULT_BORDERS = 1_000_000

/**
 * Rows and cells looked at for those borders, drawn or not: a used range of a
 * million rows with one formatted column far off would otherwise be walked a
 * row and a whole row's width at a time, the borders' cap reached only slowly
 * or never.
 */
const GRID_MAX_DEFAULT_SCANS = 10 * GRID_MAX_DEFAULT_BORDERS

/**
 * The same two counts over a whole workbook, each ten sheets' worth: a sheet's
 * caps alone leave a workbook of a thousand sheets a thousand times the work.
 * One is shared by every sheet's {@link DefaultBorders}.
 */
export class DefaultBorderBudget {
  given = 0
  scanned = 0

  spent(): boolean {
    return (
      this.given >= 10 * GRID_MAX_DEFAULT_BORDERS || this.scanned >= 10 * GRID_MAX_DEFAULT_SCANS
    )
  }
}

/** A row's default format's border; `null` where its default draws none, which still hides its columns'. */
export type RowDefault = BorderSides | null

const NO_COLUMNS: ReadonlySet<number> = new Set()

/**
 * The borders Excel draws on the cells a sheet writes nothing for: the row's
 * default format where the row has one, else the column's, else none (the
 * workbook's default draws no lines). Only inside the used range the sheet
 * declares; without one, inside the box of the cells it writes as far as they
 * have come, as the rows stream past: what Excel would draw beyond them is not
 * known yet, and guessing it would draw lines a sheet never shows.
 *
 * Rows are given in order: `gap` before each row the file writes, `fill` for
 * that row, `rest` after the last.
 */
export class DefaultBorders {
  /**
   * Each column's default border, by column; the first default to name a
   * column keeps it (a writer does not overlap them). Filled once per column,
   * so however many column defaults a file declares, the work is bounded by
   * the sheet's width.
   */
  private columns: (BorderSides | undefined)[] = []
  /** The first and last column with a default, so a row's scan covers only those. */
  private columnsFrom = Infinity
  private columnsTo = 0
  private rows = new Map<number, RowDefault>()
  private bounds: CellRange | undefined
  private seen: CellRange | undefined
  /** The last row given; a row the file writes again after it gets no defaults twice. */
  private through = 0
  private given = 0
  private scanned = 0

  constructor(private readonly workbook = new DefaultBorderBudget()) {}

  /** The sheet's used range. */
  usedRange(range: CellRange): void {
    if (range.bottom >= range.top && range.right >= range.left) {
      // A sheet is at most this wide; a dimension claiming more would only stretch every row's scan
      this.bounds = { ...range, right: Math.min(range.right, GRID_MAX_COLUMNS) }
    }
  }

  hasUsedRange(): boolean {
    return this.bounds !== undefined
  }

  /** A column default's border, for columns `min` to `max`, 1-based. */
  column(min: number, max: number, border: BorderSides | undefined): void {
    if (!border || !(min >= 1) || !(max >= min) || min > GRID_MAX_COLUMNS) return
    // Counted as looked at: a file may declare the whole width over and over
    if (this.spent()) return
    const to = Math.min(max, GRID_MAX_COLUMNS)
    this.scan(to - min + 1)
    for (let col = min; col <= to; col++) this.columns[col] ??= border
    this.columnsFrom = Math.min(this.columnsFrom, min)
    this.columnsTo = Math.max(this.columnsTo, to)
  }

  /** A row's default, before the row is given. */
  row(row: number, border: RowDefault): void {
    const b = this.bounds
    if (row <= this.through || (b && (row < b.top || row > b.bottom))) return
    if (this.spent()) return
    this.rows.set(row, border)
  }

  /** A cell the file writes, 1-based. */
  record(row: number, col: number): void {
    const s = this.seen
    if (!s) this.seen = { top: row, bottom: row, left: col, right: col }
    else {
      s.top = Math.min(s.top, row)
      s.bottom = Math.max(s.bottom, row)
      s.left = Math.min(s.left, col)
      s.right = Math.max(s.right, col)
    }
  }

  /** The rows before `before` the file writes nothing for, with the borders their defaults give. */
  *gap(before: number): Generator<{ row: number; borders: CellBorder[] }> {
    const range = this.bounds ?? this.seen
    if (!range) return
    const from = Math.max(this.through + 1, range.top)
    const to = Math.min(before - 1, range.bottom)
    if (from > to) return
    // Nothing more is drawn, so the rows' defaults are not walked for it either
    if (this.spent()) {
      this.through = Math.max(this.through, to)
      return
    }
    const rows = this.anyColumnDefault() ? count(from, to) : this.rowsWithDefaults(from, to)
    for (const row of rows) {
      if (this.spent()) break
      this.scan(1)
      const borders = this.fill(row, NO_COLUMNS, [])
      if (borders.length > 0) yield { row, borders }
    }
    this.through = Math.max(this.through, to)
    this.dropRows(from, to)
  }

  /** After the last row the file writes, to the used range's bottom. */
  rest(): Generator<{ row: number; borders: CellBorder[] }> {
    return this.gap(Infinity)
  }

  /**
   * A row's borders: its cells' own, `own` (left to right), and its defaults'
   * on the columns in range it has no record for.
   */
  fill(row: number, records: ReadonlySet<number>, own: CellBorder[]): CellBorder[] {
    const rowDefault = this.rows.get(row)
    this.rows.delete(row)
    const fresh = row > this.through
    this.through = Math.max(this.through, row)
    const range = this.bounds ?? this.seen
    if (!fresh || !range || row < range.top || row > range.bottom) return own
    // Past the cap nothing more is drawn, so nothing more is scanned either
    if (this.spent()) return own
    if (rowDefault === null || (rowDefault === undefined && !this.anyColumnDefault())) return own
    const added: CellBorder[] = []
    // A row's default spans the range; the columns' reach only as far as they were given
    const left = rowDefault !== undefined ? range.left : Math.max(range.left, this.columnsFrom)
    const right = Math.min(
      range.right,
      GRID_MAX_COLUMNS,
      rowDefault !== undefined ? Infinity : this.columnsTo
    )
    for (let col = left; col <= right; col++) {
      this.scan(1)
      if (this.spent()) break
      const border = rowDefault !== undefined ? rowDefault : this.columns[col]
      if (!border || records.has(col)) continue
      added.push({ col, ...border })
      this.given++
      this.workbook.given++
      if (this.spent()) break
    }
    if (added.length === 0) return own
    return own.length === 0 ? added : [...own, ...added].sort((a, b) => a.col - b.col)
  }

  private spent(): boolean {
    return (
      this.given >= GRID_MAX_DEFAULT_BORDERS ||
      this.scanned >= GRID_MAX_DEFAULT_SCANS ||
      this.workbook.spent()
    )
  }

  private scan(cells: number): void {
    this.scanned += cells
    this.workbook.scanned += cells
  }

  private anyColumnDefault(): boolean {
    return this.columns.length > 0
  }

  /** Row defaults from `from` to `to` are spent; walked by whichever is shorter, the span or the map. */
  private dropRows(from: number, to: number): void {
    // Counted as looked at, the span or the map: defaults for rows far below
    // stay in the map, and a file may bring every later row here over a span as long
    this.scan(Math.min(to - from + 1, this.rows.size))
    if (to - from + 1 <= this.rows.size) {
      for (let row = from; row <= to; row++) this.rows.delete(row)
      return
    }
    for (const row of this.rows.keys()) if (row <= to) this.rows.delete(row)
  }

  private rowsWithDefaults(from: number, to: number): number[] {
    this.scan(Math.min(to - from + 1, this.rows.size))
    if (to - from + 1 <= this.rows.size) {
      const rows: number[] = []
      for (let row = from; row <= to; row++) if (this.rows.get(row)) rows.push(row)
      return rows
    }
    return [...this.rows.entries()]
      .filter(([row, border]) => border && row >= from && row <= to)
      .map(([row]) => row)
      .sort((a, b) => a - b)
  }
}

function* count(from: number, to: number): Generator<number> {
  for (let n = from; n <= to; n++) yield n
}

/** A time of day drops the day a serial holds; a duration (`[h]:mm`) counts it, so a day or more stays a number. */
export type DateKind = 'date' | 'time' | 'duration'

/** What a number format shows; `either` where that depends on the language of the Excel that wrote it. */
export type FormatKind = DateKind | 'either'

/**
 * What each number format shows, by its number: the workbook's own code where
 * it defines one under that number, as it overrides a built-in format's;
 * worked out once for each format.
 */
export function formatKinds(codes: Map<number, string>): (id: number) => FormatKind | undefined {
  const kinds = new Map<number, FormatKind | undefined>()
  return (id) => {
    if (!kinds.has(id)) {
      const code = codes.get(id)
      kinds.set(id, code !== undefined ? dateKindOf(code) : builtinDateKind(id))
    }
    return kinds.get(id)
  }
}

/**
 * The built-in formats that show dates and times. 27–36 and 50–58 are the
 * ones a Japanese, Chinese or Korean Excel shows as era and CJK dates and
 * times, and the file does not say which of them wrote it: 32 and 33 are a
 * time in all of them, but 34, 35, 52, 53, 55 and 56 are a date in a Japanese
 * or Korean Excel and a time in a Chinese one.
 */
function builtinDateKind(id: number): FormatKind | undefined {
  if (id >= 18 && id <= 21) return 'time'
  if (id === 46) return 'duration'
  if (id === 45 || id === 47) return 'time'
  if (id === 32 || id === 33) return 'time'
  if ((id >= 14 && id <= 17) || id === 22) return 'date'
  if (id === 34 || id === 35 || id === 52 || id === 53 || id === 55 || id === 56) return 'either'
  if ((id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return 'date'
  return undefined
}

const FORMAT_CODE_MAX_CHARS = 1024

/**
 * Whether a format code shows a date, a time of day or a duration. Literal
 * text, colours, locales and conditions are not part of what it shows; `g`
 * and `e` are the era and era year of a Japanese date, and `[h]`, `[m]` or
 * `[s]` counts past a day.
 */
export function dateKindOf(code: string): DateKind | undefined {
  // Excel writes no code past 255 characters, and the patterns below are not
  // linear in a code made to be long
  if (code.length > FORMAT_CODE_MAX_CHARS) return undefined
  const shown = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/_.|\*./g, '')
    .replace(/\[(?!h+\]|m+\]|s+\])[^\]]*\]/gi, '')
    .replace(/E[+-]/gi, '')
    .replace(/General/gi, '')
    .replace(/AM\/PM|A\/P/gi, 'h')
  if (/[ydge]/i.test(shown)) return 'date'
  if (/\[(?:h+|m+|s+)\]/i.test(shown)) return 'duration'
  if (/[hs]/i.test(shown)) return 'time'
  // Months only: minutes never stand without hours or seconds
  if (/m/i.test(shown)) return 'date'
  return undefined
}

const DAY_MS = 86_400_000

/**
 * A serial number as an ISO 8601 date, date and time, or time. The 1900
 * system counts a 29 February 1900 that never was, so days before it are one
 * later than they count from. A time of day is the serial's fraction, whatever
 * day it holds (`NOW()` shown as `hh:mm`); a duration of a day or more stays a
 * number, as no time of day writes it.
 */
export function serialToIso(serial: number, kind: DateKind, date1904: boolean): string | undefined {
  if (!Number.isFinite(serial) || serial < 0) return undefined
  let days = Math.floor(serial)
  // Milliseconds, the finest a format shows (`ss.000`); a serial is a double, so finer is noise
  let ms = Math.round((serial - days) * DAY_MS)
  if (ms === DAY_MS) {
    days++
    ms = 0
  }
  const seconds = Math.floor(ms / 1000)
  const time =
    [seconds / 3600, (seconds / 60) % 60, seconds % 60]
      .map((part) => String(Math.floor(part)).padStart(2, '0'))
      .join(':') + (ms % 1000 === 0 ? '' : `.${String(ms % 1000).padStart(3, '0')}`)
  if (kind === 'time') return time
  if (kind === 'duration') return days === 0 ? time : undefined
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, days < 60 ? 31 : 30)
  const at = new Date(epoch + days * DAY_MS)
  if (Number.isNaN(at.getTime()) || at.getUTCFullYear() > 9999) return undefined
  const date = at.toISOString().slice(0, 10)
  return ms === 0 ? date : `${date}T${time}`
}

/**
 * A number cell: a date where its format shows one, written as ISO 8601;
 * otherwise the number, as the file writes it where it is text.
 */
export function numericCell(
  col: number,
  value: string | number,
  shown: FormatKind | undefined,
  date1904: boolean
): GridCell {
  const serial = Number(value)
  // Under a day is a time of day, and no date a sheet holds; a day or more is a date
  const kind = shown === 'either' ? (serial < 1 ? 'time' : 'date') : shown
  const iso = kind && serialToIso(serial, kind, date1904)
  return iso ? { col, kind: 'date', value: iso } : { col, kind: 'number', value: String(value) }
}
