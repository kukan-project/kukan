/**
 * The text of a Word 97–2003 document (MS-DOC), read through its piece table
 * as Word assembles it: the body, then its footnotes, endnotes and text
 * boxes. Headers, footers and comments are not part of it. A document from
 * Word 95 or before is a different format, and is not read.
 */

import { readCompoundFile } from './compound-file'

/** `wIdent`, the first two bytes of a Word document's FIB. */
const WORD_IDENT = 0xa5ec
/** `nFib` of Word 97, the oldest that writes this FIB. */
const WORD_97 = 0x00c1
const ENCRYPTED = 0x0100
const TABLE_1 = 0x0200

/**
 * The parts of the text in the order Word stores them, each by where its
 * length in characters is in the FIB's longs (`ccpText` and on), and whether
 * it is read.
 */
const PARTS = [
  { long: 3, keep: true }, // body
  { long: 4, keep: true }, // footnotes
  { long: 5, keep: false }, // headers and footers
  { long: 7, keep: false }, // comments
  { long: 8, keep: true }, // endnotes
  { long: 9, keep: true }, // text boxes
] as const
/** `fcClx` is the 34th of the FIB's offset and length pairs. */
const FC_CLX = 33

const CLX_PRC = 0x01
const CLX_PCDT = 0x02
const PCD_BYTES = 8

const FIELD_BEGIN = 0x13
const FIELD_SEPARATOR = 0x14
const FIELD_END = 0x15

/**
 * Characters Word gives a meaning to: line breaks of each kind, a table cell's
 * end — a line, as a cell's text reads as its own — and its hyphens. The rest
 * of the control characters stand for objects, notes' marks and pictures,
 * and are left out.
 */
const SPECIAL: Record<number, string> = {
  0x07: '\n',
  0x09: '\t',
  0x0b: '\n',
  0x0c: '\n',
  0x0d: '\n',
  0x0e: '\n',
  0x1e: '-',
}

const cp1252 = new TextDecoder('windows-1252')

/** The document's text, its paragraphs a line each; throws where it cannot read it. */
export function docText(bytes: Buffer): string {
  const file = readCompoundFile(bytes)
  const word = file.stream('WordDocument')
  if (!word || word.length < 154) throw new Error('DOC has no WordDocument stream')
  if (word.readUInt16LE(0) !== WORD_IDENT) throw new Error('DOC has no Word FIB')
  const nFib = word.readUInt16LE(2)
  if (nFib < WORD_97) throw new Error(`DOC is from before Word 97 (nFib ${nFib.toString(16)})`)
  const flags = word.readUInt16LE(0x0a)
  if (flags & ENCRYPTED) throw new Error('DOC is encrypted')
  const table = file.stream(flags & TABLE_1 ? '1Table' : '0Table')
  if (!table) throw new Error('DOC has no table stream')

  // The FIB past its fixed start: counts of shorts and longs, each followed by them
  const shorts = word.readUInt16LE(32)
  const longsAt = 34 + shorts * 2
  const longs = word.readUInt16LE(longsAt)
  const long = (i: number) => (i < longs ? word.readInt32LE(longsAt + 2 + i * 4) : 0)
  const pairsAt = longsAt + 2 + longs * 4
  const pairs = word.readUInt16LE(pairsAt)
  if (pairs <= FC_CLX) throw new Error('DOC FIB has no piece table')
  const clxAt = word.readUInt32LE(pairsAt + 2 + FC_CLX * 8)
  const clxBytes = word.readUInt32LE(pairsAt + 2 + FC_CLX * 8 + 4)

  const ranges: [number, number][] = []
  let at = 0
  for (const { long: i, keep } of PARTS) {
    const length = Math.max(0, long(i))
    if (keep && length > 0) ranges.push([at, at + length])
    at += length
  }
  // No more characters than the stream has bytes: a piece table whose pieces
  // all point at the same bytes would otherwise build text many times its size
  const text = pieces(word, table.subarray(clxAt, clxAt + clxBytes), Math.min(at, word.length))
  return ranges
    .map(([from, to]) => readable(text.slice(from, to)))
    .filter((part) => part.trim())
    .join('\n')
}

/** The document's first `limit` characters in order, from the pieces of the CLX's piece table. */
function pieces(word: Buffer, clx: Buffer, limit: number): string {
  let at = 0
  // Property modifiers before the piece table, which the text does not need
  while (at < clx.length && clx[at] === CLX_PRC) {
    const size = clx.readInt16LE(at + 1)
    if (size < 0) throw new Error('DOC has a property modifier of negative size')
    at += 3 + size
  }
  if (clx[at] !== CLX_PCDT || at + 5 > clx.length) throw new Error('DOC has no piece table')
  const plc = clx.subarray(at + 5, at + 5 + clx.readUInt32LE(at + 1))
  const count = Math.floor((plc.length - 4) / (4 + PCD_BYTES))
  const parts: string[] = []
  let left = limit
  for (let i = 0; i < count && left > 0; i++) {
    const length = Math.min(left, plc.readUInt32LE((i + 1) * 4) - plc.readUInt32LE(i * 4))
    const fc = plc.readUInt32LE((count + 1) * 4 + i * PCD_BYTES + 2)
    if (length <= 0) continue
    if (fc & 0x40000000) {
      const from = (fc & 0x3fffffff) / 2
      parts.push(cp1252.decode(slice(word, from, from + length)))
    } else {
      parts.push(slice(word, fc, fc + length * 2).toString('utf16le'))
    }
    left -= length
  }
  return parts.join('')
}

function slice(buffer: Buffer, from: number, to: number): Buffer {
  if (to > buffer.length) throw new Error('DOC piece runs past the end of its stream')
  return buffer.subarray(from, to)
}

/**
 * `text` as a reader sees it: a field's result kept and its instructions
 * (` HYPERLINK "…" `, ` PAGE `) left out, Word's characters for breaks given
 * as line breaks and the ones for objects dropped.
 */
function readable(text: string): string {
  // Runs of characters shown, sliced whole: one string a character costs a
  // document's text many times over in memory
  const out: string[] = []
  // Each open field: true once past its separator, into the result shown. A
  // character is shown when none is still in its instructions, which is
  // counted rather than looked for: fields nest as deep as a file makes them
  const fields: boolean[] = []
  let instructions = 0
  let run = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0x20) continue
    if (instructions === 0 && run < i) out.push(text.slice(run, i))
    run = i + 1
    if (code === FIELD_BEGIN) {
      fields.push(false)
      instructions++
    } else if (code === FIELD_SEPARATOR) {
      if (fields.length > 0 && !fields[fields.length - 1]) {
        fields[fields.length - 1] = true
        instructions--
      }
    } else if (code === FIELD_END) {
      if (fields.length > 0 && !fields.pop()) instructions--
    } else if (instructions === 0) {
      out.push(SPECIAL[code] ?? '')
    }
  }
  if (instructions === 0 && run < text.length) out.push(text.slice(run))
  // A table's empty cells and its rows' ends, a line each, run to many blank lines
  return out.join('').replace(/\n{3,}/g, '\n\n')
}
