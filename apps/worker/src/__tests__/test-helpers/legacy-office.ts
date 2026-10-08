/**
 * The legacy Office formats, written as their specifications lay them out, to
 * read back: a compound file (MS-CFB) of the streams given, and in it an XLS
 * workbook's BIFF records, a Word document's FIB and piece table, or a
 * presentation's record tree.
 */

import { COMPOUND_FILE_SIGNATURE } from '@kukan/shared'

const SECTOR = 512
const MINI_SECTOR = 64
const MINI_CUTOFF = 4096
const END_OF_CHAIN = 0xfffffffe
const FREE = 0xffffffff
const FAT_SECTOR = 0xfffffffd
const NO_STREAM = 0xffffffff

function padded(data: Buffer, size: number): Buffer {
  const rest = data.length % size
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(size - rest)])
}

/**
 * A version 3 compound file holding `streams` at its top, in a directory
 * whose entries are a chain of right siblings. A stream under 4096 bytes is
 * in the mini stream, as a writer puts it.
 */
function compoundFile(streams: Record<string, Buffer>): Buffer {
  const names = Object.keys(streams)
  const mini: Buffer[] = []
  const miniFat: number[] = []
  const starts = new Map<string, number>()
  for (const name of names) {
    const data = streams[name]
    if (data.length >= MINI_CUTOFF || data.length === 0) continue
    const first = miniFat.length
    const count = Math.ceil(data.length / MINI_SECTOR)
    for (let i = 0; i < count; i++) miniFat.push(i === count - 1 ? END_OF_CHAIN : first + i + 1)
    mini.push(padded(data, MINI_SECTOR))
    starts.set(name, first)
  }
  const miniStream = Buffer.concat(mini)

  // The regular sectors' contents, in order; the FAT goes before them all
  const blocks: { name: string; data: Buffer }[] = [
    { name: '<directory>', data: Buffer.alloc(128 * (names.length + 1)) },
    { name: '<minifat>', data: Buffer.alloc(miniFat.length * 4) },
    { name: '<ministream>', data: miniStream },
    ...names
      .filter((name) => streams[name].length >= MINI_CUTOFF)
      .map((name) => ({ name, data: streams[name] })),
  ].filter((block) => block.data.length > 0)
  const sectorsOf = (data: Buffer) => Math.ceil(data.length / SECTOR)
  const dataSectors = blocks.reduce((n, block) => n + sectorsOf(block.data), 0)
  let fatSectors = 1
  while (fatSectors * (SECTOR / 4) < fatSectors + dataSectors) fatSectors++

  const fat: number[] = Array.from({ length: fatSectors }, () => FAT_SECTOR)
  const firstSector = new Map<string, number>()
  for (const block of blocks) {
    const first = fat.length
    const count = sectorsOf(block.data)
    for (let i = 0; i < count; i++) fat.push(i === count - 1 ? END_OF_CHAIN : first + i + 1)
    firstSector.set(block.name, first)
  }
  while (fat.length % (SECTOR / 4) !== 0) fat.push(FREE)

  const entry = (
    name: string,
    type: number,
    opts: { child?: number; right?: number; start?: number; size?: number }
  ) => {
    const e = Buffer.alloc(128)
    e.write(name, 0, 'utf16le')
    e.writeUInt16LE((name.length + 1) * 2, 0x40)
    e[0x42] = type
    e[0x43] = 1
    e.writeUInt32LE(NO_STREAM, 0x44)
    e.writeUInt32LE(opts.right ?? NO_STREAM, 0x48)
    e.writeUInt32LE(opts.child ?? NO_STREAM, 0x4c)
    e.writeUInt32LE(opts.start ?? END_OF_CHAIN, 0x74)
    e.writeUInt32LE(opts.size ?? 0, 0x78)
    return e
  }
  const directory = Buffer.concat([
    entry('Root Entry', 5, {
      child: names.length > 0 ? 1 : NO_STREAM,
      start: firstSector.get('<ministream>') ?? END_OF_CHAIN,
      size: miniStream.length,
    }),
    ...names.map((name, i) =>
      entry(name, 2, {
        right: i + 1 < names.length ? i + 2 : NO_STREAM,
        start: starts.get(name) ?? firstSector.get(name) ?? END_OF_CHAIN,
        size: streams[name].length,
      })
    ),
  ])

  const header = Buffer.alloc(SECTOR)
  header.write(COMPOUND_FILE_SIGNATURE, 'latin1')
  header.writeUInt16LE(0x3e, 0x18)
  header.writeUInt16LE(3, 0x1a)
  header.writeUInt16LE(0xfffe, 0x1c)
  header.writeUInt16LE(9, 0x1e)
  header.writeUInt16LE(6, 0x20)
  header.writeUInt32LE(fatSectors, 0x2c)
  header.writeUInt32LE(firstSector.get('<directory>')!, 0x30)
  header.writeUInt32LE(MINI_CUTOFF, 0x38)
  header.writeUInt32LE(firstSector.get('<minifat>') ?? END_OF_CHAIN, 0x3c)
  header.writeUInt32LE(sectorsOf(Buffer.alloc(miniFat.length * 4)), 0x40)
  header.writeUInt32LE(END_OF_CHAIN, 0x44)
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i < fatSectors ? i : FREE, 0x4c + i * 4)

  const contents: Record<string, Buffer> = {
    '<directory>': directory,
    '<minifat>': u32(...miniFat),
  }
  return Buffer.concat([
    header,
    u32(...fat),
    ...blocks.map((block) => padded(contents[block.name] ?? block.data, SECTOR)),
  ])
}

// --- XLS ---

export function biff(type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt16LE(type, 0)
  head.writeUInt16LE(data.length, 2)
  return Buffer.concat([head, data])
}

function u16(...values: number[]): Buffer {
  const b = Buffer.alloc(values.length * 2)
  values.forEach((v, i) => b.writeUInt16LE(v, i * 2))
  return b
}

function u32(...values: number[]): Buffer {
  const b = Buffer.alloc(values.length * 4)
  values.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4))
  return b
}

function f64(value: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeDoubleLE(value, 0)
  return b
}

/** A string's characters as BIFF8 stores them: a flags byte, then bytes or UTF-16. */
function biff8Chars(text: string): Buffer {
  const wide = [...text].some((c) => c.charCodeAt(0) > 0xff)
  return Buffer.concat([
    Buffer.from([wide ? 1 : 0]),
    Buffer.from(text, wide ? 'utf16le' : 'latin1'),
  ])
}

/** An XLUnicodeString: two bytes of length, then the characters. */
function xlString(text: string): Buffer {
  return Buffer.concat([u16(text.length), biff8Chars(text)])
}

export const cell = {
  labelSst: (row: number, col: number, index: number) =>
    biff(0x00fd, Buffer.concat([u16(row, col, 0), u32(index)])),
  label: (row: number, col: number, text: string) =>
    biff(0x0204, Buffer.concat([u16(row, col, 0), xlString(text)])),
  /** A BIFF5 label: its bytes as given, in the workbook's code page. */
  label5: (row: number, col: number, bytes: Buffer) =>
    biff(0x0204, Buffer.concat([u16(row, col, 0, bytes.length), bytes])),
  number: (row: number, col: number, value: number) =>
    biff(0x0203, Buffer.concat([u16(row, col, 0), f64(value)])),
  rk: (row: number, col: number, rk: number) =>
    biff(0x027e, Buffer.concat([u16(row, col, 0), u32(rk)])),
  mulrk: (row: number, col: number, rks: number[]) =>
    biff(
      0x00bd,
      Buffer.concat([
        u16(row, col),
        ...rks.map((rk) => Buffer.concat([u16(0), u32(rk)])),
        u16(col + rks.length - 1),
      ])
    ),
  boolerr: (row: number, col: number, value: number, error: boolean) =>
    biff(0x0205, Buffer.concat([u16(row, col, 0), Buffer.from([value, error ? 1 : 0])])),
  /** A formula's cached result, and the STRING record a string result is in. */
  formula: (row: number, col: number, result: number | string | boolean | { error: number }) => {
    let value: Buffer
    if (typeof result === 'number') value = f64(result)
    else {
      value = Buffer.from([0, 0, 0, 0, 0, 0, 0xff, 0xff])
      if (typeof result === 'boolean') value.set([1, 0, result ? 1 : 0])
      else if (typeof result === 'object') value.set([2, 0, result.error])
    }
    const record = biff(0x0006, Buffer.concat([u16(row, col, 0), value, u16(0), u32(0), u16(0)]))
    return typeof result === 'string'
      ? Buffer.concat([record, biff(0x0207, xlString(result))])
      : record
  },
}

/** An RK of an integer, or of an integer's hundredth. */
export function rkInt(value: number, hundredths = false): number {
  return ((value << 2) | 0x02 | (hundredths ? 0x01 : 0)) >>> 0
}

/** An RK of a double whose low 34 bits are 0, as 1.5 and 0.25 are. */
export function rkDouble(value: number): number {
  return f64(value).readUInt32LE(4) & 0xfffffffc
}

/** The data of an SST of `strings`, each plain; a test writes one that runs on by hand. */
export function sstData(strings: string[]): Buffer {
  return Buffer.concat([u32(strings.length), u32(strings.length), ...strings.map(xlString)])
}

/** A BOF of a substream: 0x0005 the globals, 0x0010 a worksheet, 0x0020 a chart. */
export function bof(type: number, version = 0x0600): Buffer {
  return biff(0x0809, u16(version, type, 0, 0, 0, 0, 0, 0))
}

export const EOF_RECORD = biff(0x000a, Buffer.alloc(0))

interface XlsSheetSpec {
  /** In BIFF5, the code page's bytes. */
  name: string | Buffer
  /** The sheet's cell records, in the order written; a chart sheet when undefined. */
  cells?: Buffer[]
}

/**
 * A workbook of `sheets` in tab order. `globals` are records written before
 * the BOUNDSHEETs (a CODEPAGE, a FILEPASS); `sst` the SST record and its
 * CONTINUEs, whole. `biff5` writes it as Excel 95 does: a Book stream, and
 * names in the code page's bytes. `offsets` replaces where the BOUNDSHEETs say
 * the sheets are, given where they are.
 */
export function xlsBuffer(opts: {
  sheets: XlsSheetSpec[]
  globals?: Buffer[]
  sst?: Buffer
  biff5?: boolean
  offsets?: (offsets: number[]) => number[]
}): Buffer {
  const version = opts.biff5 ? 0x0500 : 0x0600
  const boundsheet = (offset: number, sheet: XlsSheetSpec) => {
    const name =
      typeof sheet.name === 'string'
        ? Buffer.concat([Buffer.from([sheet.name.length]), biff8Chars(sheet.name)])
        : Buffer.concat([Buffer.from([sheet.name.length]), sheet.name])
    return biff(0x0085, Buffer.concat([u32(offset), Buffer.from([0, sheet.cells ? 0 : 2]), name]))
  }
  const head = Buffer.concat([bof(0x0005, version), ...(opts.globals ?? [])])
  const tail = Buffer.concat([opts.sst ?? Buffer.alloc(0), EOF_RECORD])
  const bodies = opts.sheets.map((sheet) =>
    Buffer.concat([bof(sheet.cells ? 0x0010 : 0x0020, version), ...(sheet.cells ?? []), EOF_RECORD])
  )
  // A BOUNDSHEET's length does not depend on the offset in it
  const sheetsLength = opts.sheets.reduce((n, sheet) => n + boundsheet(0, sheet).length, 0)
  let offset = head.length + sheetsLength + tail.length
  const where = bodies.map((body) => {
    const at = offset
    offset += body.length
    return at
  })
  const offsets = opts.offsets?.(where) ?? where
  const sheets = opts.sheets.map((sheet, i) => boundsheet(offsets[i], sheet))
  const stream = Buffer.concat([head, ...sheets, tail, ...bodies])
  return compoundFile({ [opts.biff5 ? 'Book' : 'Workbook']: stream })
}

/** A BOF of a chart, then its EOF: a chart drawn on a sheet, as a substream of its own. */
export function chartSubstream(records: Buffer[]): Buffer {
  return Buffer.concat([bof(0x0020), ...records, EOF_RECORD])
}

// --- DOC ---

interface DocPiece {
  text: string
  /** Stored a byte a character (cp1252), not UTF-16. */
  compressed?: boolean
}

/**
 * A Word 97 document of `pieces`, in character order, whose parts — body,
 * footnotes, headers, comments, endnotes, text boxes — are as long as
 * `parts` says. `nFib` and `flags` replace the FIB's own; `repeat` lists the
 * first piece that many times over, each pointing at the same bytes;
 * `prcSize` is the size the property modifier before the piece table claims.
 */
export function docBuffer(
  pieces: DocPiece[],
  parts: {
    body: number
    footnotes?: number
    headers?: number
    comments?: number
    endnotes?: number
    boxes?: number
  },
  fib: { nFib?: number; flags?: number; repeat?: number; prcSize?: number } = {}
): Buffer {
  const pairs = 93
  const fibBytes = 154 + pairs * 8
  /** `fcClx`, the 34th offset and length pair. */
  const clxPair = 154 + 33 * 8
  const flags = fib.flags ?? 0x0200
  const texts = pieces.map((p) =>
    p.compressed ? Buffer.from(p.text, 'latin1') : Buffer.from(p.text, 'utf16le')
  )
  const word = Buffer.alloc(fibBytes)
  word.writeUInt16LE(0xa5ec, 0)
  word.writeUInt16LE(fib.nFib ?? 0x00c1, 2)
  word.writeUInt16LE(flags, 0x0a)
  word.writeUInt16LE(14, 32)
  word.writeUInt16LE(22, 62)
  const long = (i: number, value: number) => word.writeInt32LE(value, 64 + i * 4)
  long(3, parts.body)
  long(4, parts.footnotes ?? 0)
  long(5, parts.headers ?? 0)
  long(7, parts.comments ?? 0)
  long(8, parts.endnotes ?? 0)
  long(9, parts.boxes ?? 0)
  word.writeUInt16LE(pairs, 152)

  // The piece table: each piece's first character, the end, then each piece's descriptor
  const cps: number[] = [0]
  const descriptors: Buffer[] = []
  let at = fibBytes
  for (const [i, piece] of pieces.entries()) {
    const pcd = Buffer.alloc(8)
    pcd.writeUInt32LE(piece.compressed ? ((at * 2) | 0x40000000) >>> 0 : at, 2)
    for (let n = 0; n < (i === 0 ? (fib.repeat ?? 1) : 1); n++) {
      cps.push(cps[cps.length - 1] + piece.text.length)
      descriptors.push(pcd)
    }
    at += texts[i].length
  }
  const plc = Buffer.concat([u32(...cps), ...descriptors])
  // A property modifier first, which the reader steps over
  const prcSize = Buffer.alloc(2)
  prcSize.writeInt16LE(fib.prcSize ?? 2, 0)
  const clx = Buffer.concat([Buffer.from([0x01]), prcSize, Buffer.from([0, 0])])
  const pcdt = Buffer.concat([Buffer.from([0x02]), u32(plc.length), plc])
  const table = Buffer.concat([Buffer.alloc(16), clx, pcdt])
  word.writeUInt32LE(16, clxPair)
  word.writeUInt32LE(clx.length + pcdt.length, clxPair + 4)
  return compoundFile({
    WordDocument: Buffer.concat([word, ...texts]),
    [flags & 0x0200 ? '1Table' : '0Table']: table,
  })
}

// --- PPT ---

/** A record: an atom, or a container of the records `data` is. */
function pptRecord(type: number, data: Buffer, instance = 0, container = false): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt16LE((instance << 4) | (container ? 0x0f : 0), 0)
  head.writeUInt16LE(type, 2)
  head.writeUInt32LE(data.length, 4)
  return Buffer.concat([head, data])
}

function pptContainer(type: number, children: Buffer[], instance = 0): Buffer {
  return pptRecord(type, Buffer.concat(children), instance, true)
}

export const ppt = {
  chars: (text: string) => pptRecord(0x0fa0, Buffer.from(text, 'utf16le')),
  bytes: (text: string) => pptRecord(0x0fa8, Buffer.from(text, 'latin1')),
  header: (kind: number) => pptRecord(0x0f9f, u32(kind)),
  persist: (ref: number) => pptRecord(0x03f3, Buffer.concat([u32(ref), Buffer.alloc(16)])),
  /** A slide whose shapes hold `texts`, a shape each, inside a drawing. */
  slide: (texts: Buffer[]) =>
    pptContainer(0x03ee, [
      pptContainer(0x040c, [
        pptContainer(
          0xf002,
          texts.map((text) => pptContainer(0xf004, [pptContainer(0xf00d, [text])]))
        ),
      ]),
    ]),
  notes: (texts: Buffer[]) => pptContainer(0x03f0, texts),
}

interface PptEdit {
  /** Objects this edit writes, by persist id: id 1 is the document. */
  objects: Record<number, Buffer>
  /** Write no directory, and name the one before's: a crafted file's edit. */
  reuseDirectory?: boolean
  /** More ids, each where an object of this edit is, `plus` bytes into it: a crafted file's. */
  aliases?: Record<number, { of: number; plus?: number }>
}

/**
 * A presentation saved once and then incrementally for each further edit:
 * each writes its objects, a persist directory of where they are, and a user
 * edit pointing at the one before. `token` replaces the current user's
 * header token, `encrypted` gives the last user edit its encryption field.
 */
export function pptBuffer(
  edits: PptEdit[],
  opts: { token?: number; encrypted?: boolean } = {}
): Buffer {
  const parts: Buffer[] = []
  let length = 0
  let previous = 0
  let directoryAt = 0
  for (const [i, edit] of edits.entries()) {
    const offsets: [number, number][] = []
    for (const [id, object] of Object.entries(edit.objects)) {
      offsets.push([Number(id), length])
      parts.push(object)
      length += object.length
    }
    for (const [id, { of, plus = 0 }] of Object.entries(edit.aliases ?? {})) {
      offsets.push([Number(id), offsets.find(([object]) => object === of)![1] + plus])
    }
    if (!edit.reuseDirectory) {
      const directory = pptRecord(
        0x1772,
        Buffer.concat(offsets.flatMap(([id, at]) => [u32((1 << 20) | id), u32(at)]))
      )
      directoryAt = length
      parts.push(directory)
      length += directory.length
    }
    const last = i === edits.length - 1
    const userEdit = Buffer.alloc(opts.encrypted && last ? 32 : 28)
    userEdit.writeUInt32LE(previous, 8)
    userEdit.writeUInt32LE(directoryAt, 12)
    userEdit.writeUInt32LE(1, 16)
    previous = length
    const record = pptRecord(0x0ff5, userEdit)
    parts.push(record)
    length += record.length
  }
  const current = Buffer.alloc(20)
  current.writeUInt32LE(0x14, 0)
  current.writeUInt32LE(opts.token ?? 0xe391c05f, 4)
  current.writeUInt32LE(previous, 8)
  return compoundFile({
    'PowerPoint Document': Buffer.concat(parts),
    'Current User': pptRecord(0x0ff6, current),
  })
}

/**
 * A document whose slide list has, for each slide, its persist id and the
 * records after it — after the masters' list, as PowerPoint writes them, and
 * before the notes'.
 */
export function pptDocument(slides: { ref: number; records: Buffer[] }[]): Buffer {
  return pptContainer(0x03e8, [
    pptContainer(0x0ff0, [ppt.persist(98), ppt.chars('Master title style')], 1),
    pptContainer(
      0x0ff0,
      slides.flatMap((slide) => [ppt.persist(slide.ref), ...slide.records])
    ),
    pptContainer(0x0ff0, [ppt.persist(99), ppt.chars('Speaker notes')], 2),
  ])
}

// --- Ichitaro ---

/** A unit of a text stream: a code, or characters. */
type JtdUnit = number | string

function utf16be(units: JtdUnit[]): Buffer {
  return Buffer.concat(
    units.map((unit) => {
      if (typeof unit === 'string') return Buffer.from(unit, 'utf16le').swap16()
      const b = Buffer.alloc(2)
      b.writeUInt16BE(unit, 0)
      return b
    })
  )
}

/**
 * An Ichitaro text stream: its signature, then `TextV.01` blocks of `blocks`,
 * or — as an older version writes it — the `bare` units, and after either the
 * `tail` units a style section holds.
 */
export function jtdStream(opts: {
  blocks?: JtdUnit[][]
  bare?: JtdUnit[]
  tail?: JtdUnit[]
}): Buffer {
  const head = Buffer.alloc(20)
  head.write('SsmgV.01', 'latin1')
  const blocks = (opts.blocks ?? []).map((units) => {
    const body = utf16be(units)
    const marker = Buffer.alloc(12)
    marker.write('TextV.01', 'latin1')
    marker.writeUInt32BE(body.length / 2, 8)
    return Buffer.concat([marker, body])
  })
  return Buffer.concat([head, ...blocks, utf16be(opts.bare ?? []), utf16be(opts.tail ?? [])])
}

export const jtd = {
  /** A record of `kind` and its parameters, which run to the `0x001F` it ends in. */
  record: (kind: number, params: number[]): JtdUnit[] => [
    0x1c,
    kind,
    params.length + 4,
    ...params,
    0x1f,
  ],
  /** An inline: shown where it stands, or a reading of what is. */
  inline: (shown: boolean, text: string): JtdUnit[] => [
    0x1c,
    1,
    7,
    0,
    shown ? 0 : 1,
    shown ? 3 : 0x82,
    0x1d,
    text,
    0x1e,
    5,
    0,
    1,
    0x1f,
  ],
}

export function jtdBuffer(streams: Record<string, Buffer>): Buffer {
  return compoundFile(streams)
}
