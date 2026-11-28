/**
 * An XLSX workbook as grids of cells: each sheet's rows with every cell's
 * column, kind and raw value, and what the sheet says of its own layout —
 * merged ranges, hidden rows and columns, frozen panes, the autofilter, print
 * titles, and the borders drawn on its cells. Reading a sheet as a table starts
 * from these (ADR-057); the document text reader keeps only the rows' text.
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
import {
  addHiddenRow,
  addMerge,
  BORDER_STYLES,
  DefaultBorderBudget,
  DefaultBorders,
  formatKinds,
  gridSheet,
  numericCell,
  type BorderSides,
  type BorderStyle,
  type CellBorder,
  type CellRange,
  type FormatKind,
  type GridCell,
  type GridRow,
  type GridSheet,
  type GridWorkbook,
  type SheetLayout,
} from './grid'

const STYLES = 'xl/styles.xml'

/**
 * The workbook's sheets in tab order. A sheet's rows are a stream of its XML:
 * read them before asking for the next sheet.
 */
export async function* xlsxGrid(filePath: string): AsyncGenerator<GridSheet> {
  const workbook = xlsxWorkbook(filePath)
  try {
    yield* workbook.sheets()
  } finally {
    await workbook.close()
  }
}

/** The workbook, its sheets readable more than once (`GridWorkbook`). */
export function xlsxWorkbook(filePath: string): GridWorkbook {
  let opened: Promise<OpenedXlsx> | undefined
  return {
    async *sheets() {
      yield* sheetsOf(await (opened ??= openXlsx(filePath)))
    },
    async close() {
      const book = await opened?.catch(() => undefined)
      book?.zip.close()
    },
  }
}

interface OpenedXlsx {
  zip: yauzl.ZipFile
  entries: Awaited<ReturnType<typeof listEntries>>
  shared: SharedStrings
  facts: WorkbookFacts
  styles: CellStyles
}

async function openXlsx(filePath: string): Promise<OpenedXlsx> {
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
    return { zip, entries, shared, facts, styles }
  } catch (err) {
    zip.close()
    throw err
  }
}

async function* sheetsOf({
  zip,
  entries,
  shared,
  facts,
  styles,
}: OpenedXlsx): AsyncGenerator<GridSheet> {
  const read = new Set<number>()
  // One for this pass over the sheets, so a second pass draws the lines the first did
  const budget = new DefaultBorderBudget()
  for (const [index, { part, name }] of (await sheetOrder(zip, entries)).entries()) {
    const entry = entries.get(part)
    if (!entry || read.has(entry.relativeOffsetOfLocalHeader)) continue
    read.add(entry.relativeOffsetOfLocalHeader)
    const titles = name !== undefined ? facts.printTitles.get(name) : undefined
    yield gridSheet(
      {
        sheet: index + 1,
        ...(name !== undefined && { name }),
        hidden: name !== undefined && facts.hidden.has(name),
        ...(titles && { printTitles: titles }),
      },
      (layout) =>
        readPart<GridRow>(zip, entry, (emit) =>
          sheetGridParser(emit, layout, shared, styles, facts.date1904, budget)
        )
    )
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
  const codes = new Map<number, string>()
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
        codes.set(Number(tag.attributes.numFmtId), tag.attributes.formatCode ?? '')
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
    dates: formats.map(formatKinds(codes)),
    borders: borderIds.map((id) => borders[id]),
  }
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
 * past the last where a writer left it out, as its row's number is. The used
 * range (`<dimension>`) and the columns' formats (`<cols>`) come before the
 * rows, so the borders of the rows' and columns' defaults are known as rows come.
 */
function sheetGridParser(
  emit: (row: GridRow) => void,
  layout: SheetLayout,
  shared: SharedStrings,
  styles: CellStyles,
  date1904: boolean,
  budget: DefaultBorderBudget
): PartParser {
  let row = 0
  let hidden = false
  let cells: GridCell[] = []
  let borders: CellBorder[] = []
  let records = new Set<number>()
  const defaults = new DefaultBorders(budget)
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
        const read = numericCell(col, own, styles.dates[style], date1904)
        if (formula) read.formula = true
        return read
      }
    }
  }

  /** Hidden rows of no cells left to `gap`, as below. */
  const hiddenAhead = new Set<number>()
  /** Rows of no cells, as their defaults draw them. */
  const gap = (rows: Iterable<{ row: number; borders: CellBorder[] }>) => {
    for (const { row: r, borders: drawn } of rows) {
      emit({
        row: r,
        ...(hiddenAhead.has(r) && { hidden: true as const }),
        cells: [],
        borders: drawn,
      })
    }
    hiddenAhead.clear()
  }
  const styleOf = (s: string | undefined): number | undefined => {
    const n = Number(s)
    return s !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined
  }

  return {
    open(tag: SaxesTagPlain) {
      switch (tag.name) {
        case 'row': {
          const r = Number(tag.attributes.r)
          row = Number.isInteger(r) && r > 0 ? r : row + 1
          hidden = truthy(tag.attributes.hidden)
          col = 0
          if (hidden) addHiddenRow(layout, row)
          const s = styleOf(tag.attributes.s)
          if (s !== undefined && truthy(tag.attributes.customFormat)) {
            defaults.row(row, styles.borders[s] ?? null)
          }
          break
        }
        case 'dimension': {
          const range = parseRange(tag.attributes.ref)
          if (range) defaults.usedRange(range)
          break
        }
        case 'c': {
          const ref = CELL_REF.exec(tag.attributes.r ?? '')
          col = ref ? columnNumber(ref[1]!) : col + 1
          records.add(col)
          defaults.record(row, col)
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
        case 'col': {
          const min = Number(tag.attributes.min)
          const max = Number(tag.attributes.max)
          if (!Number.isInteger(min) || !Number.isInteger(max) || min <= 0 || max < min) break
          if (truthy(tag.attributes.hidden)) layout.hiddenColumns.push([min, max])
          const s = styleOf(tag.attributes.style)
          if (s !== undefined) defaults.column(min, max, styles.borders[s])
          break
        }
        case 'mergeCell': {
          const range = parseRange(tag.attributes.ref)
          if (range) addMerge(layout, range)
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
        if (records.size === 0 && !defaults.hasUsedRange()) {
          // Where no used range is given, whether the range reaches a row of no cells is known
          // only from the cells after it, as XLS's ROW records come before their cells
          if (hidden) hiddenAhead.add(row)
        } else {
          // The rows before it once its cells are known, as where no used range is given they reach to them
          gap(defaults.gap(row))
          const drawn = defaults.fill(row, records, borders)
          if (cells.length > 0 || drawn.length > 0) {
            emit({
              row,
              ...(hidden && { hidden: true as const }),
              cells,
              ...(drawn.length > 0 && { borders: drawn }),
            })
          }
        }
        cells = []
        borders = []
        records = new Set()
      } else if (tag.name === 'sheetData') gap(defaults.rest())
    },
    text(text: string) {
      if (inValue && phonetic === 0) value.add(text)
    },
  }
}
