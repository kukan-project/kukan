/**
 * The parts of an XLSX package, read as streams: the ZIP's entries, an XML part
 * through a SAX parser, the shared strings, and the sheets in tab order. What a
 * reader makes of a sheet's rows — lines of text, or a grid of cells — is its own.
 */

import { posix } from 'node:path'
import yauzl from 'yauzl'
import { SaxesParser, type SaxesTagPlain } from 'saxes'
import { DOCUMENT_TEXT_MAX_BYTES, XLSX_MAX_PART_BYTES, XLSX_MAX_SHARED_STRINGS } from '@/config'
import { openZipFile } from '../zip'

/** A limit the fallback would stop at too, only later and at more cost in memory. */
export class LimitError extends Error {}

export class TooMuchTextError extends LimitError {
  constructor() {
    super(`Document text is over ${DOCUMENT_TEXT_MAX_BYTES} bytes`)
  }
}

export const SHARED_STRINGS = 'xl/sharedStrings.xml'
export const WORKBOOK = 'xl/workbook.xml'
export const WORKBOOK_RELS = 'xl/_rels/workbook.xml.rels'
export const SHEET = /^xl\/worksheets\/sheet(\d+)\.xml$/

/**
 * The sheets' parts and names in the workbook's tab order, which need not
 * follow their file names; by the number in the name, and unnamed, where the
 * workbook does not say — the part's name (`sheet2`) would read as the
 * sheet's own.
 */
export async function sheetOrder(
  zip: yauzl.ZipFile,
  entries: Map<string, yauzl.Entry>
): Promise<{ part: string; name?: string }[]> {
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
    // Each <sheet>'s relationship id and name, in the order the tabs stand
    const tabs = readPart<[string, string | undefined]>(zip, workbook, (emit) => ({
      open(tag) {
        if (tag.name === 'sheet' && tag.attributes['r:id']) {
          emit([tag.attributes['r:id'], tag.attributes.name])
        }
      },
    }))
    const order: { part: string; name?: string }[] = []
    for await (const [id, name] of tabs) {
      const part = targets.get(id)
      if (part) order.push({ part, ...(name !== undefined && { name }) })
    }
    if (order.length > 0) return order
  }
  return [...entries.keys()]
    .filter((name) => SHEET.test(name))
    .sort((a, b) => Number(SHEET.exec(a)![1]) - Number(SHEET.exec(b)![1]))
    .map((part) => ({ part }))
}

/** Shared strings joined into one string at a time, and the characters they may come to. */
export const SHARED_CHUNK_STRINGS = 4096
export const SHARED_CHUNK_CHARS = 64 * 1024

/**
 * The shared strings, joined a few thousand at a time and found by their
 * offsets. Held one by one, each costs tens of bytes over its text, and one
 * the parser sliced from the part keeps that whole chunk of it alive.
 */
export class SharedStrings {
  private readonly joined: string[] = []
  private readonly offsets: Uint32Array[] = []
  /** The index of each chunk's first string. */
  private readonly starts: number[] = []
  private held: string[] = []
  private heldChars = 0
  private count = 0
  private bytes = 0

  add(text: string): void {
    // One longer than a chunk is a chunk of its own: joined with others, it
    // would be held twice while it was copied, and joined alone it is not copied
    if (text.length > SHARED_CHUNK_CHARS) this.end()
    if (++this.count > XLSX_MAX_SHARED_STRINGS) {
      throw new LimitError(`XLSX has over ${XLSX_MAX_SHARED_STRINGS} shared strings`)
    }
    // A writer keeps the strings its cells show: more than the text may come to is more text
    this.bytes += Buffer.byteLength(text, 'utf-8')
    if (this.bytes > DOCUMENT_TEXT_MAX_BYTES) throw new TooMuchTextError()
    this.heldChars += text.length
    const held = this.held.push(text)
    if (held === SHARED_CHUNK_STRINGS || this.heldChars >= SHARED_CHUNK_CHARS) this.end()
  }

  /** Join the strings still held; the reader calls it after the last one too. */
  end(): void {
    if (this.held.length === 0) return
    const offsets = new Uint32Array(this.held.length + 1)
    for (const [i, text] of this.held.entries()) offsets[i + 1] = offsets[i]! + text.length
    this.joined.push(this.held.join(''))
    this.offsets.push(offsets)
    this.starts.push(this.count - this.held.length)
    this.held = []
    this.heldChars = 0
  }

  /** The string at `index`, a cell's value, or none where an array would have none. */
  get(index: number): string | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) return undefined
    // Chunks end at a count or at a size, so the chunk is found by where each starts
    let low = 0
    let high = this.starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (this.starts[mid]! <= index) low = mid
      else high = mid - 1
    }
    const offsets = this.offsets[low]!
    const at = index - this.starts[low]!
    return this.joined[low]!.slice(offsets[at], offsets[at + 1])
  }
}

/** Text events held before they are joined. */
export const TEXT_CHUNK_PARTS = 4096

/**
 * A string or a cell's text from the parser's text events, joined a chunk at
 * a time: added one at a time, millions of `<t>` in one make a rope of a node
 * each, from a part of a few hundred kilobytes compressed.
 */
export class TextParts {
  private chunks: string[] = []
  private parts: string[] = []
  private length = 0

  add(text: string): void {
    // UTF-16 units are no more than UTF-8 bytes
    this.length += text.length
    if (this.length > DOCUMENT_TEXT_MAX_BYTES) throw new TooMuchTextError()
    if (this.parts.push(text) < TEXT_CHUNK_PARTS) return
    this.chunks.push(this.parts.join(''))
    this.parts = []
  }

  /** The text, taken once the element ends. */
  text(): string {
    // A value is mostly one text event: taken as it is, it leaves nothing to clear
    if (this.chunks.length === 0 && this.parts.length <= 1) return this.parts.pop() ?? ''
    return this.chunks.concat(this.parts).join('')
  }

  clear(): void {
    if (this.chunks.length > 0) this.chunks = []
    if (this.parts.length > 0) this.parts = []
    this.length = 0
  }
}

/** Each `<si>`'s text; a phonetic reading (`<rPh>`) is not part of it. */
export function sharedStringParser(emit: (text: string) => void): PartParser {
  const current = new TextParts()
  let inString = false
  let inText = false
  let phonetic = 0
  return {
    open(tag: SaxesTagPlain) {
      if (tag.name === 'si') {
        current.clear()
        inString = true
      } else if (tag.name === 'rPh') phonetic++
      else if (tag.name === 't') inText = true
    },
    close(tag: SaxesTagPlain) {
      if (tag.name === 'si' && inString) {
        emit(current.text())
        inString = false
      } else if (tag.name === 'rPh') phonetic--
      else if (tag.name === 't') inText = false
    },
    text(text: string) {
      if (inText && phonetic === 0 && inString) current.add(text)
    },
  }
}

/** Elements an XLSX part may nest, where writers nest them about ten deep. */
export const XLSX_MAX_DEPTH = 256

export interface PartParser {
  open(tag: SaxesTagPlain): void
  close?(tag: SaxesTagPlain): void
  text?(text: string): void
}

/**
 * Stream one part of the ZIP through a SAX parser, yielding what it emits as
 * the XML arrives rather than once the part has been read.
 */
export async function* readPart<T>(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  parserFor: (emit: (item: T) => void) => PartParser
): AsyncGenerator<T> {
  if (entry.uncompressedSize > XLSX_MAX_PART_BYTES) {
    throw new LimitError(
      `${entry.fileName} is ${entry.uncompressedSize} bytes uncompressed, over ${XLSX_MAX_PART_BYTES}`
    )
  }
  const ready: T[] = []
  const handlers = parserFor((item) => ready.push(item))
  const sax = new SaxesParser()
  // The parser holds each open element: nested millions deep, they fill the heap
  let depth = 0
  sax.on('opentag', (tag) => {
    if (++depth > XLSX_MAX_DEPTH) {
      throw new LimitError(`${entry.fileName} nests elements over ${XLSX_MAX_DEPTH} deep`)
    }
    handlers.open(tag)
  })
  sax.on('closetag', (tag) => {
    depth--
    handlers.close?.(tag)
  })
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

export function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return openZipFile(filePath, { lazyEntries: true, autoClose: false })
}

export function listEntries(zip: yauzl.ZipFile): Promise<Map<string, yauzl.Entry>> {
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

export function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) =>
      err || !stream
        ? reject(err ?? new Error(`Failed to read ${entry.fileName}`))
        : resolve(stream)
    )
  })
}
