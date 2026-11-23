/**
 * An XLSX workbook as grids of cells: each sheet's rows with every cell's
 * column, kind and raw value, and what the sheet says of its own layout —
 * merged ranges, hidden rows and columns, frozen panes, the autofilter, print
 * titles, and the borders drawn on its cells. Reading a sheet as a table starts
 * from these (ADR-057); the document text reader keeps only the rows' text.
 *
 * Values are raw, not as a number format shows them: `1234`, not `1,234`. Only
 * a date is rewritten, from its serial number to ISO 8601, as a format is all
 * that tells it from a number.
 */

import type yauzl from 'yauzl'
import type { SaxesTagPlain } from 'saxes'
import { XLSX_MAX_ENTRIES } from '@/config'
import {
  LimitError,
  listEntries,
  openZip,
  readPart,
  SHARED_STRINGS,
  SharedStrings,
  sharedStringParser,
  sheetOrder,
  TextParts,
  WORKBOOK,
  type PartParser,
} from '../document/xlsx-package'

const STYLES = 'xl/styles.xml'

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

const BORDER_STYLES = [
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

/** A border's line, as the file names it. */
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
   * The cells with a border, left to right, empty ones included. A line
   * between two cells may be on either: the bottom of one or the top of the
   * next. Borders a whole row or column is styled with are not here.
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
 * The workbook's sheets in tab order. A sheet's rows are a stream of its XML:
 * read them before asking for the next sheet.
 */
export async function* xlsxGrid(filePath: string): AsyncGenerator<GridSheet> {
  const zip = await openZip(filePath)
  try {
    if (zip.entryCount > XLSX_MAX_ENTRIES) {
      throw new LimitError(`XLSX has ${zip.entryCount} entries, over ${XLSX_MAX_ENTRIES}`)
    }
    const entries = await listEntries(zip)
    const shared = new SharedStrings()
    const strings = entries.get(SHARED_STRINGS)
    if (strings) {
      for await (const text of readPart(zip, strings, sharedStringParser)) shared.add(text)
      shared.end()
    }
    const facts = await workbookFacts(zip, entries)
    const styles = await cellStyles(zip, entries)
    const read = new Set<number>()
    for (const [index, { part, name }] of (await sheetOrder(zip, entries)).entries()) {
      const entry = entries.get(part)
      if (!entry || read.has(entry.relativeOffsetOfLocalHeader)) continue
      read.add(entry.relativeOffsetOfLocalHeader)
      const layout: SheetLayout = {
        merges: [],
        hiddenColumns: [],
        hiddenRows: [],
        hiddenRowCount: 0,
        uncachedFormulas: 0,
      }
      let done = false
      const rows = (async function* () {
        yield* readPart<GridRow>(zip, entry, (emit) =>
          sheetGridParser(emit, layout, shared, styles, facts.date1904)
        )
        done = true
      })()
      const titles = name !== undefined ? facts.printTitles.get(name) : undefined
      yield {
        sheet: index + 1,
        ...(name !== undefined && { name }),
        hidden: name !== undefined && facts.hidden.has(name),
        ...(titles && { printTitles: titles }),
        rows,
        layout() {
          if (!done) throw new Error('A sheet has a layout once its rows are read')
          return layout
        },
      }
    }
  } finally {
    zip.close()
  }
}

interface WorkbookFacts {
  date1904: boolean
  /** Names of the sheets not shown as tabs. */
  hidden: Set<string>
  printTitles: Map<string, NonNullable<GridSheet['printTitles']>>
}

/** What the workbook part says of its sheets beyond their order. */
async function workbookFacts(
  zip: yauzl.ZipFile,
  entries: Map<string, yauzl.Entry>
): Promise<WorkbookFacts> {
  const facts: WorkbookFacts = { date1904: false, hidden: new Set(), printTitles: new Map() }
  const workbook = entries.get(WORKBOOK)
  if (!workbook) return facts
  const names: string[] = []
  const titles: [number, string][] = []
  const text = new TextParts()
  let local: number | undefined
  const parts = readPart<never>(zip, workbook, () => ({
    open(tag) {
      if (tag.name === 'workbookPr') facts.date1904 = truthy(tag.attributes.date1904)
      else if (tag.name === 'sheet') {
        const name = tag.attributes.name ?? ''
        names.push(name)
        const state = tag.attributes.state
        if (state === 'hidden' || state === 'veryHidden') facts.hidden.add(name)
      } else if (tag.name === 'definedName') {
        const sheet = Number(tag.attributes.localSheetId)
        local =
          tag.attributes.name === '_xlnm.Print_Titles' && Number.isInteger(sheet)
            ? sheet
            : undefined
        text.clear()
      }
    },
    close(tag) {
      if (tag.name !== 'definedName') return
      if (local !== undefined) titles.push([local, text.text()])
      local = undefined
    },
    text(chunk) {
      if (local !== undefined) text.add(chunk)
    },
  }))
  for await (const _ of parts) void _
  for (const [sheet, formula] of titles) {
    const name = names[sheet]
    const spans = printTitleSpans(formula)
    if (name !== undefined && spans) facts.printTitles.set(name, spans)
  }
  return facts
}

function truthy(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

/** `Sheet1!$A:$B,Sheet1!$1:$3` as its column span and its row span. */
export function printTitleSpans(formula: string): GridSheet['printTitles'] {
  const spans: NonNullable<GridSheet['printTitles']> = {}
  for (const match of formula.matchAll(
    /!\$?(?:([A-Z]{1,3})\$?:\$?([A-Z]{1,3})|(\d{1,7}):\$?(\d{1,7}))(?=,|$)/g
  )) {
    if (match[1] && match[2]) spans.columns = [columnNumber(match[1]), columnNumber(match[2])]
    else spans.rows = [Number(match[3]), Number(match[4])]
  }
  return spans.rows || spans.columns ? spans : undefined
}

/** A time of day drops the day a serial holds; a duration (`[h]:mm`) counts it, so a day or more stays a number. */
type DateKind = 'date' | 'time' | 'duration'

/** What a number format shows; `either` where that depends on the language of the Excel that wrote it. */
type FormatKind = DateKind | 'either'

interface CellStyles {
  /** For each cell style (`s`), whether its number format shows a date or a time. */
  dates: (FormatKind | undefined)[]
  /** For each cell style, the border it draws. */
  borders: (BorderSides | undefined)[]
}

const BORDER_SIDES: Record<string, keyof BorderSides> = {
  top: 'top',
  bottom: 'bottom',
  left: 'left',
  right: 'right',
  // What a right-to-left-aware writer names the left and right sides
  start: 'left',
  end: 'right',
}

function borderStyle(name: string | undefined): BorderStyle | undefined {
  if (!name || name === 'none') return undefined
  // A style this does not know is still a line
  return (BORDER_STYLES as readonly string[]).includes(name) ? (name as BorderStyle) : 'thin'
}

/** What the styles part says of each cell style: its number format and its border. */
async function cellStyles(
  zip: yauzl.ZipFile,
  entries: Map<string, yauzl.Entry>
): Promise<CellStyles> {
  const styles = entries.get(STYLES)
  if (!styles) return { dates: [], borders: [] }
  const custom = new Map<number, DateKind | undefined>()
  const formats: number[] = []
  const borders: (BorderSides | undefined)[] = []
  const borderIds: number[] = []
  let inCellXfs = false
  // Differential formats hold `<border>` too; only the `<borders>` list is indexed by `borderId`
  let inBorders = false
  let border: BorderSides | undefined
  const parts = readPart<never>(zip, styles, () => ({
    open(tag) {
      if (tag.name === 'numFmt') {
        custom.set(Number(tag.attributes.numFmtId), dateKindOf(tag.attributes.formatCode ?? ''))
      } else if (tag.name === 'cellXfs') inCellXfs = true
      else if (tag.name === 'xf' && inCellXfs) {
        formats.push(Number(tag.attributes.numFmtId ?? 0))
        borderIds.push(Number(tag.attributes.borderId ?? 0))
      } else if (tag.name === 'borders') inBorders = true
      else if (tag.name === 'border' && inBorders) border = {}
      else if (border) {
        const side = BORDER_SIDES[tag.name]
        const style = side && borderStyle(tag.attributes.style)
        if (side && style) border[side] = style
      }
    },
    close(tag) {
      if (tag.name === 'cellXfs') inCellXfs = false
      else if (tag.name === 'borders') inBorders = false
      else if (tag.name === 'border' && border) {
        borders.push(Object.keys(border).length > 0 ? border : undefined)
        border = undefined
      }
    },
  }))
  for await (const _ of parts) void _
  return {
    dates: formats.map((id) => (custom.has(id) ? custom.get(id) : builtinDateKind(id))),
    borders: borderIds.map((id) => borders[id]),
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

/**
 * Whether a format code shows a date, a time of day or a duration. Literal
 * text, colours, locales and conditions are not part of what it shows; `g`
 * and `e` are the era and era year of a Japanese date, and `[h]`, `[m]` or
 * `[s]` counts past a day.
 */
export function dateKindOf(code: string): DateKind | undefined {
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

/** `AB` as 28. */
function columnNumber(letters: string): number {
  let n = 0
  for (const letter of letters) n = n * 26 + (letter.charCodeAt(0) - 64)
  return n
}

const CELL_REF = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/

/** `B2:D5`, or a single `B2`, as a range. */
export function parseRange(ref: string | undefined): CellRange | undefined {
  if (!ref) return undefined
  const [from, to = from] = ref.split(':')
  const a = CELL_REF.exec(from ?? '')
  const b = CELL_REF.exec(to ?? '')
  if (!a || !b) return undefined
  return {
    top: Number(a[2]),
    left: columnNumber(a[1]!),
    bottom: Number(b[2]),
    right: columnNumber(b[1]!),
  }
}

/**
 * Each `<row>` as its cells with a value or a border, and the sheet's layout as the
 * elements around its rows say it. A cell's column is its own (`r`), or one
 * past the last where a writer left it out, as its row's number is.
 */
function sheetGridParser(
  emit: (row: GridRow) => void,
  layout: SheetLayout,
  shared: SharedStrings,
  styles: CellStyles,
  date1904: boolean
): PartParser {
  let row = 0
  let hidden = false
  let cells: GridCell[] = []
  let borders: CellBorder[] = []
  let col = 0
  let type: string | undefined
  let style = 0
  let formula = false
  let hasValue = false
  const value = new TextParts()
  let inValue = false
  let phonetic = 0

  const cell = (own: string): GridCell | undefined => {
    const base = { col, ...(formula && { formula: true as const }) }
    switch (type) {
      case 's': {
        const text = shared.get(Number(own))
        return text ? { ...base, kind: 'text', value: text } : undefined
      }
      case 'inlineStr':
      case 'str':
        return own ? { ...base, kind: 'text', value: own } : undefined
      case 'b':
        return { ...base, kind: 'boolean', value: own === '1' ? 'true' : 'false' }
      case 'e':
        return own ? { ...base, kind: 'error', value: own } : undefined
      case 'd':
        return own ? { ...base, kind: 'date', value: own } : undefined
      default: {
        if (!own) return undefined
        const shown = styles.dates[style]
        // Under a day is a time of day, and no date a sheet holds; a day or more is a date
        const kind = shown === 'either' ? (Number(own) < 1 ? 'time' : 'date') : shown
        const iso = kind && serialToIso(Number(own), kind, date1904)
        return iso ? { ...base, kind: 'date', value: iso } : { ...base, kind: 'number', value: own }
      }
    }
  }

  return {
    open(tag: SaxesTagPlain) {
      switch (tag.name) {
        case 'row': {
          const r = Number(tag.attributes.r)
          row = Number.isInteger(r) && r > 0 ? r : row + 1
          hidden = truthy(tag.attributes.hidden)
          col = 0
          if (hidden) {
            layout.hiddenRowCount++
            if (layout.hiddenRows.length < GRID_MAX_HIDDEN_ROWS) layout.hiddenRows.push(row)
          }
          break
        }
        case 'c': {
          const ref = CELL_REF.exec(tag.attributes.r ?? '')
          col = ref ? columnNumber(ref[1]!) : col + 1
          type = tag.attributes.t
          const s = Number(tag.attributes.s ?? 0)
          style = Number.isInteger(s) && s >= 0 ? s : 0
          formula = false
          hasValue = false
          value.clear()
          break
        }
        case 'f':
          formula = true
          break
        case 'v':
        case 't':
          inValue = true
          hasValue = true
          break
        case 'rPh':
          phonetic++
          break
        case 'pane': {
          const state = tag.attributes.state
          if (state === 'frozen' || state === 'frozenSplit') {
            layout.frozen = {
              rows: Math.max(0, Math.trunc(Number(tag.attributes.ySplit ?? 0)) || 0),
              columns: Math.max(0, Math.trunc(Number(tag.attributes.xSplit ?? 0)) || 0),
            }
          }
          break
        }
        case 'col':
          if (truthy(tag.attributes.hidden)) {
            const min = Number(tag.attributes.min)
            const max = Number(tag.attributes.max)
            if (Number.isInteger(min) && Number.isInteger(max) && min > 0 && max >= min) {
              layout.hiddenColumns.push([min, max])
            }
          }
          break
        case 'mergeCell': {
          const range = parseRange(tag.attributes.ref)
          if (!range) break
          if (layout.merges.length >= GRID_MAX_MERGES) {
            throw new LimitError(`A sheet merges over ${GRID_MAX_MERGES} ranges`)
          }
          layout.merges.push(range)
          break
        }
        case 'autoFilter':
          layout.autoFilter ??= parseRange(tag.attributes.ref)
          break
      }
    },
    close(tag: SaxesTagPlain) {
      if (tag.name === 'v' || tag.name === 't') inValue = false
      else if (tag.name === 'rPh') phonetic--
      else if (tag.name === 'c') {
        // Taken once: taking the text empties it
        const own = value.text()
        // An empty `<v/>` caches nothing, except a text result, which may be the empty string
        const cached = hasValue && (type === 'str' || own !== '')
        if (formula && !cached) layout.uncachedFormulas++
        const read = cell(own)
        if (read) cells.push(read)
        const border = styles.borders[style]
        if (border) borders.push({ col, ...border })
      } else if (tag.name === 'row') {
        if (cells.length > 0 || borders.length > 0) {
          emit({
            row,
            ...(hidden && { hidden: true as const }),
            cells,
            ...(borders.length > 0 && { borders }),
          })
        }
        cells = []
        borders = []
      }
    },
    text(text: string) {
      if (inValue && phonetic === 0) value.add(text)
    },
  }
}
