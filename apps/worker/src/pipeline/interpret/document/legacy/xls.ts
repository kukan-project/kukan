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
const FORMULA = 0x0006
const STRING = 0x0207
const BOOLERR = 0x0205

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

interface BiffRecord {
  type: number
  data: Buffer
  /** The data of the CONTINUE records after it, which a long string runs on into. */
  continues: Buffer[]
}

/** The workbook's worksheets in tab order, each with its rows; throws where it cannot read them. */
export function* xlsSheets(bytes: Buffer): Generator<XlsSheet> {
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
  const sheets: { offset: number; name: Buffer }[] = []
  for (const record of globals) {
    if (record.type === EOF) break
    if (record.type === FILEPASS) throw new Error('XLS is encrypted')
    if (record.type === CODEPAGE) codePage = record.data.readUInt16LE(0)
    else if (record.type === BOUNDSHEET) {
      sheets.push({ offset: record.data.readUInt32LE(0), name: record.data.subarray(6) })
    } else if (record.type === SST && biff8) shared = sharedStrings(record)
  }
  const text = new Strings(biff8, decoderFor(codePage))

  // The bytes the sheets' records take in all, at most twice the stream's: sheets
  // that all start at one place, or each inside the last, would otherwise have it
  // walked once for each
  const budget = { bytes: stream.length * 2 }
  const seen = new Set<number>()
  for (const [index, sheet] of sheets.entries()) {
    // A chart, a macro sheet or a module is told apart by its own BOF, and has no rows
    if (seen.has(sheet.offset) || !isWorksheet(stream, sheet.offset)) continue
    seen.add(sheet.offset)
    yield {
      sheet: index + 1,
      name: text.short(sheet.name),
      rows: sheetRows(stream, sheet.offset, text, shared, budget),
    }
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
function* sheetRows(
  stream: Buffer,
  offset: number,
  text: Strings,
  shared: string[],
  budget: { bytes: number }
): Generator<XlsRow> {
  let row = -1
  let cells = new Map<number, string>()
  const ready: XlsRow[] = []
  const flush = () => {
    if (cells.size > 0) {
      const values = [...cells.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)
      ready.push({ row: row + 1, cells: values })
    }
    cells = new Map()
  }
  const put = (data: Buffer, value: string, col = data.readUInt16LE(2)) => {
    if (!value) return
    const at = data.readUInt16LE(0)
    if (at !== row) {
      flush()
      row = at
    }
    cells.set(col, value)
  }
  let depth = 0
  /** The cell a formula's string result, in the STRING record after it, is for. */
  let pending: Buffer | undefined
  for (const record of records(stream, offset)) {
    // Its CONTINUEs too, which a sheet inside another would have read again
    budget.bytes -= record.continues.reduce(
      (n, part) => n + 4 + part.length,
      4 + record.data.length
    )
    if (budget.bytes < 0) throw new Error('XLS walks its sheets over and over')
    yield* ready.splice(0)
    const { type, data } = record
    if (type === BOF) {
      depth++
      continue
    }
    if (type === EOF) {
      if (--depth === 0) break
      continue
    }
    // A chart drawn on the sheet is a substream of its own, and its records are not cells
    if (depth > 1) continue
    if (type === LABELSST) put(data, shared[data.readUInt32LE(6)] ?? '')
    else if (type === LABEL || type === RSTRING) put(data, text.long(record, 6))
    else if (type === NUMBER) put(data, String(data.readDoubleLE(6)))
    else if (type === RK) put(data, String(rkValue(data.readUInt32LE(6))))
    else if (type === MULRK) {
      const first = data.readUInt16LE(2)
      const count = Math.floor((data.length - 6) / 6)
      for (let i = 0; i < count; i++)
        put(data, String(rkValue(data.readUInt32LE(6 + i * 6))), first + i)
    } else if (type === BOOLERR) {
      put(data, data[7] ? (ERRORS[data[6]] ?? '') : String(data[6]))
    } else if (type === FORMULA) {
      pending = undefined
      if (data.readUInt16LE(12) !== 0xffff) put(data, String(data.readDoubleLE(6)))
      else if (data[6] === 0) pending = data
      else if (data[6] === 1) put(data, String(data[8]))
      else if (data[6] === 2) put(data, ERRORS[data[8]] ?? '')
    } else if (type === STRING && pending) {
      put(pending, text.long(record, 0))
      pending = undefined
    }
  }
  flush()
  yield* ready
}

/** The records from `offset`, each with the CONTINUE records that follow it. */
function* records(stream: Buffer, offset: number): Generator<BiffRecord> {
  let at = offset
  let current: BiffRecord | undefined
  while (at + 4 <= stream.length) {
    const type = stream.readUInt16LE(at)
    const length = stream.readUInt16LE(at + 2)
    const data = stream.subarray(at + 4, at + 4 + length)
    if (data.length < length) throw new Error('XLS record runs past the end of its stream')
    at += 4 + length
    if (type === CONTINUE && current) {
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
class Strings {
  constructor(
    private readonly biff8: boolean,
    private readonly decoder: TextDecoder
  ) {}

  /** A sheet name: a byte of length, then — in BIFF8 — a byte of flags. */
  short(data: Buffer): string {
    const length = data[0] ?? 0
    if (!this.biff8) return this.decoder.decode(data.subarray(1, 1 + length))
    return new Reader([data.subarray(2)]).chars(length, (data[1] & 0x01) !== 0)
  }

  /** A cell's string at `at` in `record`: two bytes of length, then — in BIFF8 — a byte of flags. */
  long(record: BiffRecord, at: number): string {
    const { data } = record
    const length = data.readUInt16LE(at)
    if (!this.biff8) return this.decoder.decode(data.subarray(at + 2, at + 2 + length))
    const high = (data[at + 2] & 0x01) !== 0
    return new Reader([data.subarray(at + 3), ...record.continues]).chars(length, high)
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
