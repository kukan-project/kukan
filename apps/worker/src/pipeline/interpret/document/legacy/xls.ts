/**
 * The cells of an XLS workbook (MS-XLS): BIFF8, which Excel 97 to 2003 wrote,
 * and BIFF5, Excel 5 and 95's. Values are given as the file stores them —
 * numbers unformatted, a formula's last result — as the XLSX reader gives a
 * cell's `<v>`, so a workbook reads the same in either format.
 */

import { readCompoundFile } from './compound-file'

const BOF = 0x0809
const EOF = 0x000a
const FILEPASS = 0x002f
const CODEPAGE = 0x0042
const BOUNDSHEET = 0x0085
const SST = 0x00fc
const CONTINUE = 0x003c
const LABELSST = 0x00fd
const LABEL = 0x0204
const RSTRING = 0x00d6
const NUMBER = 0x0203
const RK = 0x027e
const MULRK = 0x00bd
const BLANK = 0x0201
const MULBLANK = 0x00be
const FORMULA = 0x0006
const STRING = 0x0207
const BOOLERR = 0x0205

/** What a formula's definition is spread over: these may stand between it and its STRING. */
const FORMULA_PARTS = new Set([0x04bc, 0x0221, 0x0236]) // SHRFMLA, ARRAY, TABLE

/**
 * Bytes of the stream for each CONTINUE record a walk of it holds, on average:
 * each held costs far more than its 4 bytes of header, and a writer fills them.
 * A comment's text, the shortest, comes with records of some hundred bytes around it.
 */
const MIN_CONTINUE_BYTES = 32

const BIFF8 = 0x0600
const BIFF5 = 0x0500
const GLOBALS = 0x0005
const WORKSHEET = 0x0010

/** The errors a cell can hold, as Excel writes them. */
const ERRORS: Record<number, string> = {
  0x00: '#NULL!',
  0x07: '#DIV/0!',
  0x0f: '#VALUE!',
  0x17: '#REF!',
  0x1d: '#NAME?',
  0x24: '#NUM!',
  0x2a: '#N/A',
}

/** Encoding names for the code pages a BIFF5 workbook names; Windows Western otherwise. */
const CODE_PAGES: Record<number, string> = {
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1200: 'utf-16le',
  10000: 'macintosh',
  32768: 'macintosh',
}

export interface XlsRow {
  /** 1-based, as the sheet numbers it. */
  row: number
  /** The row's non-empty cells, left to right. */
  cells: string[]
}

export interface XlsSheet {
  /** 1-based, in the order of the workbook's tabs, counting the sheets that are not worksheets. */
  sheet: number
  name: string
  /** Read as they are iterated, before the next sheet is asked for. */
  rows: Iterable<XlsRow>
}

export interface BiffRecord {
  type: number
  data: Buffer
  /** The data of the CONTINUE records after it, which a long string runs on into. */
  continues: Buffer[]
}

/** A worksheet the globals list, before its records are read. */
interface XlsSheetEntry {
  /** 1-based, in the order of the workbook's tabs, counting the sheets that are not worksheets. */
  sheet: number
  name: string
  /** Not shown as a tab (hidden, or very hidden). */
  hidden: boolean
  /** Where its BOF is in the stream. */
  offset: number
}

/** A workbook's globals, read: what every sheet's records are read with. */
export interface XlsWorkbook {
  stream: Buffer
  biff8: boolean
  text: Strings
  /** The SST's strings, through `cellText`. */
  shared: string[]
  /** The worksheets, in tab order; charts, macro sheets and modules left out. */
  sheets: XlsSheetEntry[]
  /**
   * The bytes the sheets' records may take in all, at most twice the stream's:
   * sheets that all start at one place, or each inside the last, would
   * otherwise have it walked once for each.
   */
  budget: { bytes: number }
  /** The globals' records, for what a caller reads beyond these. */
  globals: BiffRecord[]
}

/**
 * A cell as its record gives it, row and column 0-based as the file numbers
 * them, with the number of its format (XF). A number is the double the file
 * stores; a boolean the byte it stores. An empty string, or an error Excel does
 * not write, is a cell with no value, as a `blank` is; `uncached` is a formula
 * whose string result, in the STRING record after it, never came.
 */
export type XlsCell = { row: number; col: number; xf: number } & (
  | { kind: 'text' | 'error'; value: string; formula?: true }
  | { kind: 'number' | 'boolean'; value: number; formula?: true }
  | { kind: 'blank' | 'uncached' }
)

/** A worksheet's cells in the order written, and its other records among them. */
export type XlsSheetEvent = XlsCell | { kind: 'record'; record: BiffRecord }

/**
 * Read a workbook's globals; throws where it cannot. A cell's string is passed
 * through `cellText`, a shared string's once however many cells name it.
 */
export function readXlsWorkbook(
  bytes: Buffer,
  cellText: (text: string) => string = (text) => text
): XlsWorkbook {
  const file = readCompoundFile(bytes)
  const stream = file.stream('Workbook') ?? file.stream('Book')
  if (!stream) throw new Error('XLS has no workbook stream')

  const globals = records(stream, 0)
  const bof = globals.next()
  if (bof.done || bof.value.type !== BOF) throw new Error('XLS workbook does not start with a BOF')
  const version = bof.value.data.readUInt16LE(0)
  if (version !== BIFF8 && version !== BIFF5) {
    throw new Error(`XLS is BIFF version ${version.toString(16)}, not BIFF5 or BIFF8`)
  }
  if (bof.value.data.readUInt16LE(2) !== GLOBALS) throw new Error('XLS workbook has no globals')
  const biff8 = version === BIFF8

  let codePage = 1252
  let shared: string[] = []
  const bound: { offset: number; state: number; name: Buffer }[] = []
  const walked: BiffRecord[] = []
  for (const record of globals) {
    if (record.type === EOF) break
    walked.push(record)
    if (record.type === FILEPASS) throw new Error('XLS is encrypted')
    if (record.type === CODEPAGE) codePage = record.data.readUInt16LE(0)
    else if (record.type === BOUNDSHEET) {
      bound.push({
        offset: record.data.readUInt32LE(0),
        state: record.data[4] & 0x03,
        name: record.data.subarray(6),
      })
    } else if (record.type === SST && biff8) shared = sharedStrings(record).map(cellText)
  }
  const text = new Strings(biff8, decoderFor(codePage), cellText)

  const seen = new Set<number>()
  const sheets: XlsSheetEntry[] = []
  for (const [index, sheet] of bound.entries()) {
    // A chart, a macro sheet or a module is told apart by its own BOF, and has no rows
    if (seen.has(sheet.offset) || !isWorksheet(stream, sheet.offset)) continue
    seen.add(sheet.offset)
    sheets.push({
      sheet: index + 1,
      name: text.short(sheet.name),
      hidden: sheet.state !== 0,
      offset: sheet.offset,
    })
  }
  return {
    stream,
    biff8,
    text,
    shared,
    sheets,
    budget: { bytes: stream.length * 2 },
    globals: walked,
  }
}

/**
 * The workbook's worksheets in tab order, each with its rows; throws where it
 * cannot read them. A cell's string is passed through `cellText`, a shared
 * string's once however many cells name it.
 */
export function* xlsSheets(
  bytes: Buffer,
  cellText: (text: string) => string = (text) => text
): Generator<XlsSheet> {
  const book = readXlsWorkbook(bytes, cellText)
  for (const sheet of book.sheets) {
    yield { sheet: sheet.sheet, name: sheet.name, rows: sheetRows(book, sheet.offset) }
  }
}

function isWorksheet(stream: Buffer, offset: number): boolean {
  return (
    offset + 8 <= stream.length &&
    stream.readUInt16LE(offset) === BOF &&
    stream.readUInt16LE(offset + 6) === WORKSHEET
  )
}

/**
 * The rows of the worksheet whose BOF is at `offset`, a row at a time as its
 * cells come: a writer puts a row's cells together, a block of rows in order.
 * A cell of a row already given, from one that did not, comes as a row of its own.
 */
function* sheetRows(book: XlsWorkbook, offset: number): Generator<XlsRow> {
  let row = -1
  let cells = new Map<number, string>()
  const close = (): XlsRow | undefined => {
    if (cells.size === 0) return undefined
    const values = [...cells.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)
    cells = new Map()
    return { row: row + 1, cells: values }
  }
  for (const cell of sheetCells(book, offset)) {
    if (cell.kind === 'record') continue
    const value = cellString(cell)
    if (!value) continue
    if (cell.row !== row) {
      const closed = close()
      if (closed) yield closed
      row = cell.row
    }
    cells.set(cell.col, value)
  }
  const last = close()
  if (last) yield last
}

/** A cell's value as the document text writes it; a boolean as its `1` or `0`. */
function cellString(cell: XlsCell): string | undefined {
  switch (cell.kind) {
    case 'text':
    case 'error':
      return cell.value
    case 'number':
    case 'boolean':
      return String(cell.value)
    default:
      return undefined
  }
}

/**
 * The cells of the worksheet whose BOF is at `offset` in the order its records
 * write them, a MULRK's or MULBLANK's one by one, and the sheet's other records
 * between them.
 */
export function* sheetCells(book: XlsWorkbook, offset: number): Generator<XlsSheetEvent> {
  /** A formula whose string result is in the STRING record after it. */
  let pending: { row: number; col: number; xf: number } | undefined
  for (const record of sheetRecords(book.stream, offset, book.budget)) {
    const { type, data } = record
    if (pending && type !== STRING && !FORMULA_PARTS.has(type)) {
      yield { ...pending, kind: 'uncached' }
      pending = undefined
    }
    // A cell record's row, column and format; read only by the cases that are one
    const row = () => data.readUInt16LE(0)
    const col = () => data.readUInt16LE(2)
    const xf = () => data.readUInt16LE(4)
    switch (type) {
      case LABELSST:
        yield {
          row: row(),
          col: col(),
          xf: xf(),
          kind: 'text',
          value: book.shared[data.readUInt32LE(6)] ?? '',
        }
        break
      case LABEL:
      case RSTRING:
        yield { row: row(), col: col(), xf: xf(), kind: 'text', value: book.text.long(record, 6) }
        break
      case NUMBER:
        yield { row: row(), col: col(), xf: xf(), kind: 'number', value: data.readDoubleLE(6) }
        break
      case RK:
        yield {
          row: row(),
          col: col(),
          xf: xf(),
          kind: 'number',
          value: rkValue(data.readUInt32LE(6)),
        }
        break
      case MULRK: {
        const count = Math.floor((data.length - 6) / 6)
        for (let i = 0; i < count; i++) {
          yield {
            row: row(),
            col: col() + i,
            xf: data.readUInt16LE(4 + i * 6),
            kind: 'number',
            value: rkValue(data.readUInt32LE(6 + i * 6)),
          }
        }
        break
      }
      case BLANK:
        yield { row: row(), col: col(), xf: xf(), kind: 'blank' }
        break
      case MULBLANK: {
        const count = Math.floor((data.length - 6) / 2)
        for (let i = 0; i < count; i++) {
          yield { row: row(), col: col() + i, xf: data.readUInt16LE(4 + i * 2), kind: 'blank' }
        }
        break
      }
      case BOOLERR:
        yield data[7]
          ? { row: row(), col: col(), xf: xf(), kind: 'error', value: ERRORS[data[6]] ?? '' }
          : { row: row(), col: col(), xf: xf(), kind: 'boolean', value: data[6] }
        break
      case FORMULA: {
        const at = { row: row(), col: col(), xf: xf() }
        if (data.readUInt16LE(12) !== 0xffff) {
          yield { ...at, kind: 'number', value: data.readDoubleLE(6), formula: true }
        } else if (data[6] === 0) pending = at
        else if (data[6] === 1) yield { ...at, kind: 'boolean', value: data[8], formula: true }
        else if (data[6] === 2) {
          yield { ...at, kind: 'error', value: ERRORS[data[8]] ?? '', formula: true }
        } else yield { ...at, kind: 'text', value: '', formula: true } // An empty string
        break
      }
      case STRING:
        if (pending) {
          yield { ...pending, kind: 'text', value: book.text.long(record, 0), formula: true }
          pending = undefined
        }
        break
      default:
        yield { kind: 'record', record }
    }
  }
  if (pending) yield { ...pending, kind: 'uncached' }
}

/**
 * The records of the worksheet whose BOF is at `offset`, to its EOF, counted
 * against `budget`: not its BOF and EOF, nor those of a chart drawn on it,
 * which is a substream of its own and whose records are not the sheet's.
 */
function* sheetRecords(
  stream: Buffer,
  offset: number,
  budget: { bytes: number }
): Generator<BiffRecord> {
  let depth = 0
  for (const record of records(stream, offset)) {
    // Its CONTINUEs too, which a sheet inside another would have read again
    budget.bytes -= record.continues.reduce(
      (n, part) => n + 4 + part.length,
      4 + record.data.length
    )
    if (budget.bytes < 0) throw new Error('XLS walks its sheets over and over')
    if (record.type === BOF) {
      depth++
      continue
    }
    if (record.type === EOF) {
      if (--depth === 0) return
      continue
    }
    if (depth === 1) yield record
  }
}

/** The records from `offset`, each with the CONTINUE records that follow it. */
function* records(stream: Buffer, offset: number): Generator<BiffRecord> {
  let at = offset
  let current: BiffRecord | undefined
  let continues = Math.floor(stream.length / MIN_CONTINUE_BYTES)
  while (at + 4 <= stream.length) {
    const type = stream.readUInt16LE(at)
    const length = stream.readUInt16LE(at + 2)
    const data = stream.subarray(at + 4, at + 4 + length)
    if (data.length < length) throw new Error('XLS record runs past the end of its stream')
    at += 4 + length
    if (type === CONTINUE && current) {
      if (--continues < 0) throw new Error('XLS has more CONTINUE records than its size allows')
      current.continues.push(data)
      continue
    }
    if (current) yield current
    current = { type, data, continues: [] }
  }
  if (current) yield current
}

/** The SST's strings, which run on into its CONTINUE records. */
function sharedStrings(record: BiffRecord): string[] {
  const reader = new Reader([record.data, ...record.continues])
  reader.skip(4)
  const count = reader.u32()
  const strings: string[] = []
  for (let i = 0; i < count && !reader.done(); i++) {
    const length = reader.u16()
    const flags = reader.u8()
    const runs = flags & 0x08 ? reader.u16() : 0
    const extra = flags & 0x04 ? reader.u32() : 0
    strings.push(reader.chars(length, (flags & 0x01) !== 0))
    // The runs of formatting, and the phonetic reading, which is not the text
    reader.skip(runs * 4 + extra)
  }
  return strings
}

/** A cell's or a sheet name's string, as BIFF8 (UTF-16, or bytes of it) or BIFF5 (the code page) writes it. */
export class Strings {
  constructor(
    private readonly biff8: boolean,
    private readonly decoder: TextDecoder,
    private readonly cellText: (text: string) => string
  ) {}

  /** A sheet name: a byte of length, then — in BIFF8 — a byte of flags. */
  short(data: Buffer): string {
    const length = data[0] ?? 0
    if (!this.biff8) return this.decoder.decode(data.subarray(1, 1 + length))
    return new Reader([data.subarray(2)]).chars(length, (data[1] & 0x01) !== 0)
  }

  /**
   * A cell's string at `at` in `record`, through `cellText`: two bytes of
   * length, then — in BIFF8 — a byte of flags.
   */
  long(record: BiffRecord, at: number): string {
    const { data } = record
    const length = data.readUInt16LE(at)
    const high = (data[at + 2] & 0x01) !== 0
    const text = this.biff8
      ? new Reader([data.subarray(at + 3), ...record.continues]).chars(length, high)
      : this.decoder.decode(data.subarray(at + 2, at + 2 + length))
    return this.cellText(text)
  }
}

/**
 * Bytes read across a record and its CONTINUE records. A string's characters
 * that run on into the next start it with a byte of flags of their own, saying
 * whether they are two bytes each or one.
 */
class Reader {
  private part = 0
  private at = 0

  constructor(private readonly parts: Buffer[]) {}

  done(): boolean {
    this.settle()
    return this.part >= this.parts.length
  }

  u8(): number {
    this.settle()
    const part = this.parts[this.part]
    if (!part) throw new Error('XLS string runs past the end of its record')
    return part[this.at++]
  }

  u16(): number {
    return this.u8() | (this.u8() << 8)
  }

  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0
  }

  skip(bytes: number): void {
    let left = bytes
    while (left > 0) {
      this.settle()
      const part = this.parts[this.part]
      if (!part) return
      const step = Math.min(left, part.length - this.at)
      this.at += step
      left -= step
    }
  }

  /** `count` characters, two bytes each where `high`, one — the low byte — where not. */
  chars(count: number, high: boolean): string {
    let text = ''
    let left = count
    let wide = high
    while (left > 0) {
      const part = this.parts[this.part]
      if (!part) throw new Error('XLS string runs past the end of its record')
      if (this.at >= part.length) {
        this.part++
        this.at = 0
        wide = (this.u8() & 0x01) !== 0
        continue
      }
      const width = wide ? 2 : 1
      const take = Math.min(left, Math.floor((part.length - this.at) / width))
      if (take === 0) throw new Error('XLS string splits a character between records')
      const end = this.at + take * width
      text += part.toString(wide ? 'utf16le' : 'latin1', this.at, end)
      this.at = end
      left -= take
    }
    return text
  }

  /** Step past an exhausted part, but not into the next one's flag byte when a string is mid-way. */
  private settle(): void {
    while (this.part < this.parts.length && this.at >= this.parts[this.part].length) {
      this.part++
      this.at = 0
    }
  }
}

/** A decoder for a BIFF5 workbook's code page; Windows Western for one it does not know. */
function decoderFor(codePage: number): TextDecoder {
  try {
    return new TextDecoder(CODE_PAGES[codePage] ?? `windows-${codePage}`)
  } catch {
    return new TextDecoder('windows-1252')
  }
}

/** Where an RK's double is put together, one for every cell. */
const RK_DOUBLE = new DataView(new ArrayBuffer(8))

/** An RK value: a 30-bit integer, or a double's high 30 bits, either perhaps a hundredth of it. */
function rkValue(rk: number): number {
  let value: number
  if (rk & 0x02) value = rk >> 2
  else {
    RK_DOUBLE.setUint32(0, 0, true)
    RK_DOUBLE.setUint32(4, (rk & 0xfffffffc) >>> 0, true)
    value = RK_DOUBLE.getFloat64(0, true)
  }
  return rk & 0x01 ? value / 100 : value
}
