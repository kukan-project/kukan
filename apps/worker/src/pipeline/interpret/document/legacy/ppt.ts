/**
 * The text of a PowerPoint 97–2003 presentation (MS-PPT), a slide at a time
 * in the order the presentation shows them. A slide's text is in two places:
 * its placeholders' in the list of slides the document keeps, and its other
 * shapes' — text boxes, tables, drawings — in the slide's own record. Notes
 * and the masters are not part of it.
 */

import { readCompoundFile } from './compound-file'

const DOCUMENT = 0x03e8
const SLIDE = 0x03ee
const SLIDE_PERSIST_ATOM = 0x03f3
const TEXT_HEADER_ATOM = 0x0f9f
const TEXT_CHARS_ATOM = 0x0fa0
const TEXT_BYTES_ATOM = 0x0fa8
const SLIDE_LIST_WITH_TEXT = 0x0ff0
const USER_EDIT_ATOM = 0x0ff5
const CURRENT_USER_ATOM = 0x0ff6
const PERSIST_DIRECTORY_ATOM = 0x1772

/** A UserEditAtom this long has an encryption session's reference in it. */
const ENCRYPTED_USER_EDIT_BYTES = 0x20
const UNENCRYPTED_TOKEN = 0xe391c05f
/** The slide list of the slides; 1 is the masters', 2 the notes'. */
const SLIDES_INSTANCE = 0
const TITLE = 0
const CENTER_TITLE = 6

/** Records walked at most, against a file whose containers claim each other over and over. */
const MAX_RECORDS = 1_000_000

export interface PptSlide {
  /** The slide's title placeholder's text, where it has one. */
  title?: string
  text: string
}

interface PptRecord {
  instance: number
  type: number
  /** Where its data starts in the stream. */
  start: number
  end: number
  container: boolean
}

/** The presentation's slides in order; throws where it cannot read them. */
export function pptSlides(bytes: Buffer): PptSlide[] {
  const file = readCompoundFile(bytes)
  const doc = file.stream('PowerPoint Document')
  const user = file.stream('Current User')
  if (!doc || !user) throw new Error('PPT has no PowerPoint Document or Current User stream')

  const current = header(user, 0)
  if (
    current.type !== CURRENT_USER_ATOM ||
    current.end > user.length ||
    current.end - current.start < 12
  ) {
    throw new Error('PPT has no current user')
  }
  if (user.readUInt32LE(current.start + 4) !== UNENCRYPTED_TOKEN)
    throw new Error('PPT is encrypted')

  // The latest edit first: an object's offset is the one the latest edit to write it gives
  const offsets = new Map<number, number>()
  // The directories' bytes read in all, no more than the stream has: edits that
  // all name one directory would otherwise have it read once for each
  const directories = { bytes: doc.length }
  let documentRef: number | undefined
  let edit = user.readUInt32LE(current.start + 8)
  for (;;) {
    const atom = header(doc, edit)
    if (atom.type !== USER_EDIT_ATOM || atom.end > doc.length)
      throw new Error('PPT user edit is broken')
    if (atom.end - atom.start >= ENCRYPTED_USER_EDIT_BYTES) throw new Error('PPT is encrypted')
    documentRef ??= doc.readUInt32LE(atom.start + 16)
    persistDirectory(doc, doc.readUInt32LE(atom.start + 12), offsets, directories)
    const previous = doc.readUInt32LE(atom.start + 8)
    // An earlier edit is earlier in the stream, the first pointing at 0; one that is not would loop
    if (previous === 0 || previous >= edit) break
    edit = previous
  }
  const documentAt = documentRef === undefined ? undefined : offsets.get(documentRef)
  if (documentAt === undefined) throw new Error('PPT has no document')
  const document = header(doc, documentAt)
  if (document.type !== DOCUMENT) throw new Error('PPT document is not where its edits say')

  const budget = { records: MAX_RECORDS }
  const list = children(doc, document, budget).find(
    (r) => r.type === SLIDE_LIST_WITH_TEXT && r.instance === SLIDES_INSTANCE
  )
  if (!list) return []
  const slides: PptSlide[] = []
  /** The slide being read, and the kind of text the last text header said follows. */
  let slide: { lines: string[]; title?: string; ref: number; kind?: number } | undefined
  // Each slide's own record read once, by where it is: a list naming one slide
  // over and over, by one id or many, would otherwise have its text many times
  // the file's size. And no more text in all than the stream has bytes, which
  // a slide's record holding another's would otherwise get past
  const read = new Set<number>()
  let chars = 0
  const counted = (text: string) => {
    chars += text.length
    if (chars > doc.length) throw new Error('PPT reads more text than it holds')
    return text
  }
  const finish = () => {
    if (!slide) return
    const at = offsets.get(slide.ref)
    if (at !== undefined && !read.has(at)) {
      read.add(at)
      const own = header(doc, at)
      if (own.type === SLIDE) {
        // A placeholder's text is in the list, and the shape holds a reference to it; a
        // writer that copies it into the shape as well would have it read twice
        const listed = new Set(slide.lines)
        for (const text of texts(doc, own, budget)) {
          if (!listed.has(text)) slide.lines.push(counted(text))
        }
      }
    }
    slides.push({
      ...(slide.title && { title: slide.title }),
      text: slide.lines.filter((line) => line.trim()).join('\n'),
    })
  }
  for (const record of children(doc, list, budget)) {
    if (record.type === SLIDE_PERSIST_ATOM) {
      finish()
      slide = { lines: [], ref: doc.readUInt32LE(record.start) }
    } else if (slide && record.type === TEXT_HEADER_ATOM) {
      slide.kind = doc.readUInt32LE(record.start)
    } else if (slide && (record.type === TEXT_CHARS_ATOM || record.type === TEXT_BYTES_ATOM)) {
      const text = textOf(doc, record)
      const title = slide.kind === TITLE || slide.kind === CENTER_TITLE
      if (title && slide.title === undefined) slide.title = text
      slide.lines.push(counted(text))
    }
  }
  finish()
  return slides
}

/** The record header at `at`: its instance, type, and where its data is. */
function header(stream: Buffer, at: number): PptRecord {
  if (at + 8 > stream.length) throw new Error('PPT record runs past the end of its stream')
  const verInstance = stream.readUInt16LE(at)
  const start = at + 8
  return {
    instance: verInstance >> 4,
    type: stream.readUInt16LE(at + 2),
    start,
    end: start + stream.readUInt32LE(at + 4),
    container: (verInstance & 0x0f) === 0x0f,
  }
}

/** The records directly inside `container`, as far as its stream goes. */
function children(stream: Buffer, container: PptRecord, budget: { records: number }): PptRecord[] {
  const found: PptRecord[] = []
  const end = Math.min(container.end, stream.length)
  for (let at = container.start; at + 8 <= end;) {
    if (--budget.records < 0) throw new Error('PPT has more records than it can hold')
    const record = header(stream, at)
    found.push(record)
    at = record.end
  }
  return found
}

/** The text atoms anywhere inside `container`, in the order they are written. */
function texts(stream: Buffer, container: PptRecord, budget: { records: number }): string[] {
  const found: string[] = []
  const pending = [container]
  while (pending.length > 0) {
    const record = pending.pop()!
    if (record.type === TEXT_CHARS_ATOM || record.type === TEXT_BYTES_ATOM) {
      found.push(textOf(stream, record))
    } else if (record.container) {
      pending.push(...children(stream, record, budget).reverse())
    }
  }
  return found
}

/**
 * A text atom's text: UTF-16, or the low bytes of it. Its paragraphs end in
 * carriage returns, and a line break within one is a vertical tab; the last
 * one's end would leave a blank line before the next shape's text.
 */
function textOf(stream: Buffer, record: PptRecord): string {
  if (record.end > stream.length) throw new Error('PPT text runs past the end of its stream')
  const text =
    record.type === TEXT_CHARS_ATOM
      ? stream.toString('utf16le', record.start, record.end)
      : stream.toString('latin1', record.start, record.end)
  return text.replace(/[\r\v]/g, '\n').trimEnd()
}

/** Add a persist directory's object offsets to `offsets`, those already there kept: they are later. */
function persistDirectory(
  stream: Buffer,
  at: number,
  offsets: Map<number, number>,
  /** The directories' bytes left to read; one past it is a crafted file. */
  budget: { bytes: number }
): void {
  const directory = header(stream, at)
  if (directory.type !== PERSIST_DIRECTORY_ATOM || directory.end > stream.length) {
    throw new Error('PPT persist directory is broken')
  }
  budget.bytes -= directory.end - directory.start
  if (budget.bytes < 0) throw new Error('PPT reads its persist directories over and over')
  for (let p = directory.start; p + 4 <= directory.end;) {
    const entry = stream.readUInt32LE(p)
    const first = entry & 0xfffff
    const count = entry >>> 20
    p += 4
    for (let i = 0; i < count && p + 4 <= directory.end; i++, p += 4) {
      if (!offsets.has(first + i)) offsets.set(first + i, stream.readUInt32LE(p))
    }
  }
}
