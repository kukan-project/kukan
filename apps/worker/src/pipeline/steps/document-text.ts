/**
 * The text of a document file, a line at a time, for the Index step — without
 * parsing the whole document at once, which took gigabytes for megabytes of
 * text (see PDF_RANGE_BYTES). PDFs go through officeparser a range of pages at
 * a time; XLSX sheets are read as a stream of XML; other formats whole.
 */

import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { stat } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
import { posix } from 'node:path'
import yauzl from 'yauzl'
import { SaxesParser, type SaxesTagPlain } from 'saxes'
import { OfficeParser, type OfficeParserConfig } from 'officeparser'
import {
  PDF_RANGE_BYTES,
  PDF_RANGE_MAX_PAGES,
  PDF_RANGE_MIN_PAGES,
  XLSX_MAX_ENTRIES,
  XLSX_MAX_PART_BYTES,
} from '@/config'

/**
 * Flowing text, not the v8 default: a PDF page rendered as a space-padded
 * monospace grid only inflates what we index and hand to the suggest side.
 */
const TEXT_OPTIONS = { textConfig: { preserveLayout: false } } as const

/** What the text does not need: colours, and every node's coordinates. */
const PDF_TEXT_ONLY: OfficeParserConfig = {
  ignorePageGeometry: true,
  pdfParserConfig: { extractTextColor: false },
}

export interface ExtractedText {
  /** Whether any line had more than white space on it */
  hasText: boolean
  /** UTF-8 bytes of the text, the newlines between its lines included */
  bytes: number
}

/**
 * Write the text of the document at `filePath` to `textPath`, a line at a
 * time, reading it another way where the first fails (`fallbackLines`).
 */
export async function extractDocumentText(
  filePath: string,
  format: string,
  textPath: string
): Promise<ExtractedText> {
  try {
    return await writeLines(documentLines(filePath, format), textPath)
  } catch (err) {
    const fallback = fallbackLines(format)
    if (!fallback) throw err
    return writeLines(fallback(filePath), textPath)
  }
}

/** Write `lines` to `path`, newline-separated. */
async function writeLines(lines: AsyncIterable<string>, path: string): Promise<ExtractedText> {
  const out = createWriteStream(path)
  let hasText = false
  let count = 0
  try {
    for await (const line of lines) {
      if (!hasText && line.trim()) hasText = true
      if (!out.write(count++ > 0 ? '\n' + line : line)) await once(out, 'drain')
    }
  } finally {
    out.end()
    await finished(out)
  }
  return { hasText, bytes: out.bytesWritten }
}

export async function* documentLines(filePath: string, format: string): AsyncGenerator<string> {
  if (format === 'pdf') yield* pdfLines(filePath)
  else if (format === 'xlsx') yield* xlsxLines(filePath)
  else yield* wholeDocumentLines(filePath)
}

async function* wholeDocumentLines(filePath: string): AsyncGenerator<string> {
  yield* (await officeText(filePath)).split('\n')
}

/**
 * Another way to read `format` when `documentLines` fails partway, or none.
 * An XLSX the strict XML reader refuses may be one officeparser reads, at its
 * cost in memory; it cannot take back what it yielded, so the caller restarts.
 */
function fallbackLines(format: string): ((filePath: string) => AsyncGenerator<string>) | undefined {
  return format === 'xlsx' ? wholeDocumentLines : undefined
}

async function officeText(filePath: string, config?: OfficeParserConfig): Promise<string> {
  const ast = await OfficeParser.parseOffice(filePath, config)
  return (await ast.to('text', TEXT_OPTIONS)).value
}

/**
 * A range of pages at a time, sized by the file's bytes per page. The first
 * range is the smallest, and says how many pages there are.
 */
async function* pdfLines(filePath: string): AsyncGenerator<string> {
  const { size } = await stat(filePath)
  let first = 1
  let count = PDF_RANGE_MIN_PAGES
  let pages = Infinity
  let yielded = false
  while (first <= pages) {
    const last = Math.min(first + count - 1, pages)
    const ast = await OfficeParser.parseOffice(filePath, {
      ...PDF_TEXT_ONLY,
      pdfParserConfig: { ...PDF_TEXT_ONLY.pdfParserConfig, pageRange: `${first}-${last}` },
    })
    const total = ast.metadata?.pages
    if (typeof total !== 'number') {
      // Without the page count, ranges cannot be walked: read it whole, as before
      yield* (await officeText(filePath, PDF_TEXT_ONLY)).split('\n')
      return
    }
    if (first === 1) {
      pages = total
      count = Math.min(
        Math.max(Math.floor(PDF_RANGE_BYTES / (size / pages)), PDF_RANGE_MIN_PAGES),
        PDF_RANGE_MAX_PAGES
      )
    }
    first = last + 1
    const text = (await ast.to('text', TEXT_OPTIONS)).value
    // As a whole-document parse joins pages: a blank line between those with
    // text, nothing for those without
    if (!text) continue
    if (yielded) yield ''
    yield* text.split('\n')
    yielded = true
  }
}

const SHARED_STRINGS = 'xl/sharedStrings.xml'
const WORKBOOK = 'xl/workbook.xml'
const WORKBOOK_RELS = 'xl/_rels/workbook.xml.rels'
const SHEET = /^xl\/worksheets\/sheet(\d+)\.xml$/

/**
 * A row per line, its non-empty cells separated by tabs, sheet after sheet in
 * the workbook's tab order. Only the shared strings are held whole — every
 * cell refers to them by index.
 */
async function* xlsxLines(filePath: string): AsyncGenerator<string> {
  const zip = await openZip(filePath)
  try {
    if (zip.entryCount > XLSX_MAX_ENTRIES) {
      throw new Error(`XLSX has ${zip.entryCount} entries, over ${XLSX_MAX_ENTRIES}`)
    }
    const entries = await listEntries(zip)
    const shared: string[] = []
    const strings = entries.get(SHARED_STRINGS)
    if (strings) {
      for await (const text of readPart(zip, strings, sharedStringParser)) shared.push(text)
    }
    for (const name of await sheetOrder(zip, entries)) {
      const sheet = entries.get(name)
      if (sheet) yield* readPart(zip, sheet, (emit) => sheetRowParser(emit, shared))
    }
  } finally {
    zip.close()
  }
}

/**
 * The sheets' parts in the workbook's tab order, which need not follow their
 * file names; by the number in the name where the workbook does not say.
 */
async function sheetOrder(zip: yauzl.ZipFile, entries: Map<string, yauzl.Entry>) {
  const workbook = entries.get(WORKBOOK)
  const rels = entries.get(WORKBOOK_RELS)
  if (workbook && rels) {
    const targets = new Map<string, string>()
    const relationships = readPart<[string, string]>(zip, rels, (emit) => ({
      open(tag) {
        if (tag.name === 'Relationship') emit([tag.attributes.Id, tag.attributes.Target])
      },
    }))
    for await (const [id, target] of relationships) {
      // Absolute from the package root, or relative to the workbook's folder
      targets.set(id, target.startsWith('/') ? target.slice(1) : posix.join('xl', target))
    }
    // Each <sheet>'s relationship id, in the order the tabs stand
    const tabs = readPart<string>(zip, workbook, (emit) => ({
      open(tag) {
        if (tag.name === 'sheet' && tag.attributes['r:id']) emit(tag.attributes['r:id'])
      },
    }))
    const order: string[] = []
    for await (const id of tabs) {
      const target = targets.get(id)
      if (target) order.push(target)
    }
    if (order.length > 0) return order
  }
  return [...entries.keys()]
    .filter((name) => SHEET.test(name))
    .sort((a, b) => Number(SHEET.exec(a)![1]) - Number(SHEET.exec(b)![1]))
}

/** Each `<si>`'s text; a phonetic reading (`<rPh>`) is not part of it. */
function sharedStringParser(emit: (text: string) => void): PartParser {
  let current: string | undefined
  let inText = false
  let phonetic = 0
  return {
    open(tag: SaxesTagPlain) {
      if (tag.name === 'si') current = ''
      else if (tag.name === 'rPh') phonetic++
      else if (tag.name === 't') inText = true
    },
    close(tag: SaxesTagPlain) {
      if (tag.name === 'si' && current !== undefined) {
        emit(current)
        current = undefined
      } else if (tag.name === 'rPh') phonetic--
      else if (tag.name === 't') inText = false
    },
    text(text: string) {
      if (inText && phonetic === 0 && current !== undefined) current += text
    },
  }
}

/** Each `<row>` as its cells' values, shared strings looked up. */
function sheetRowParser(emit: (row: string) => void, shared: string[]): PartParser {
  let cells: string[] = []
  let type: string | undefined
  let value = ''
  let inValue = false
  let phonetic = 0
  return {
    open(tag: SaxesTagPlain) {
      if (tag.name === 'c') {
        type = tag.attributes.t
        value = ''
      } else if (tag.name === 'rPh') phonetic++
      else if (tag.name === 'v' || tag.name === 't') inValue = true
    },
    close(tag: SaxesTagPlain) {
      if (tag.name === 'v' || tag.name === 't') inValue = false
      else if (tag.name === 'rPh') phonetic--
      else if (tag.name === 'c') {
        const text = type === 's' ? (shared[Number(value)] ?? '') : value
        // Formatted but empty: officeparser leaves such cells out, and rows of them
        if (text) cells.push(text)
      } else if (tag.name === 'row') {
        if (cells.length > 0) emit(cells.join('\t'))
        cells = []
      }
    },
    text(text: string) {
      if (inValue && phonetic === 0) value += text
    },
  }
}

interface PartParser {
  open(tag: SaxesTagPlain): void
  close?(tag: SaxesTagPlain): void
  text?(text: string): void
}

/**
 * Stream one part of the ZIP through a SAX parser, yielding what it emits as
 * the XML arrives rather than once the part has been read.
 */
async function* readPart<T>(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  parserFor: (emit: (item: T) => void) => PartParser
): AsyncGenerator<T> {
  if (entry.uncompressedSize > XLSX_MAX_PART_BYTES) {
    throw new Error(
      `${entry.fileName} is ${entry.uncompressedSize} bytes uncompressed, over ${XLSX_MAX_PART_BYTES}`
    )
  }
  const ready: T[] = []
  const handlers = parserFor((item) => ready.push(item))
  const sax = new SaxesParser()
  sax.on('opentag', (tag) => handlers.open(tag))
  sax.on('closetag', (tag) => handlers.close?.(tag))
  sax.on('text', (text) => handlers.text?.(text))
  sax.on('cdata', (text) => handlers.text?.(text))
  // A chunk can end inside a multi-byte character
  const decoder = new TextDecoder()
  for await (const chunk of await openEntry(zip, entry)) {
    sax.write(decoder.decode(chunk as Buffer, { stream: true }))
    yield* ready.splice(0)
  }
  sax.write(decoder.decode())
  sax.close()
  yield* ready.splice(0)
}

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (err, zip) =>
      err || !zip ? reject(err ?? new Error('Failed to open XLSX')) : resolve(zip)
    )
  })
}

function listEntries(zip: yauzl.ZipFile): Promise<Map<string, yauzl.Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, yauzl.Entry>()
    zip.on('entry', (entry: yauzl.Entry) => {
      entries.set(entry.fileName, entry)
      zip.readEntry()
    })
    zip.on('end', () => resolve(entries))
    zip.on('error', reject)
    zip.readEntry()
  })
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) =>
      err || !stream
        ? reject(err ?? new Error(`Failed to read ${entry.fileName}`))
        : resolve(stream)
    )
  })
}
