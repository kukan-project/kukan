/**
 * The text of an Ichitaro document (`.jtd`, `.jtt`) of Ver.8 or later (ADR-051),
 * read from its `DocumentText` stream and then its `LayoutBoxText`, where newer
 * versions keep the text of their layout boxes. The format has no published
 * specification: what is read follows the OpenJTD project's observations
 * (RFC 0003, Apache-2.0), not a reverse engineering of our own.
 *
 * A stream is UTF-16BE. Text runs from a `0x001F` to the next control code, a
 * line break or a tab not ending it. A record starts at a `0x001C` and runs,
 * by the length it gives, to the `0x001F` it ends in; its parameters, printable
 * or not, are not text. An inline record holds `0x001D … 0x001E`: a ruby's
 * base or a form's field, shown where it stands, or — its fourth unit 1 — a
 * reading or a template's instruction, which no reader sees there and is
 * given at the end of its line. Newer versions say where the text ends (`TextV.01` and its
 * length); an older one is read to its end, the lines that are mostly not
 * text — formatting read as characters — left out.
 */

import { readCompoundFile } from './compound-file'

const STREAMS = ['DocumentText', 'LayoutBoxText'] as const
const SIGNATURE = 'SsmgV.01'
/** A text block's marker, a big-endian count of UTF-16 units after it, and those units. */
const TEXT_BLOCK = 'TextV.01'

const TEXT = 0x001f
const RECORD = 0x001c
const INLINE = 0x001d
const INLINE_END = 0x001e
/** The kind of record an inline is. */
const INLINE_KIND = 0x0001
/** A table row's end, a page's end: what a line break stands for. */
const BREAKS = new Set([0x000a, 0x000c, 0x000d, 0x000e])
/** Units an inline's end is looked for within; one past it is not an inline. */
const INLINE_MAX_UNITS = 256
/** An inline record's fourth unit where it is a reading or an instruction, not what is shown. */
const ANNOTATION = 1

/**
 * The share of a line's characters that must be in the ranges Japanese text
 * is written in (ADR-051 §4): formatting read as characters falls well under
 * it, text well over, and any value between gives the same lines.
 */
const TEXT_SHARE = 0.5

/** The document's text, its paragraphs a line each; throws where it cannot read it. */
export function jtdText(bytes: Buffer): string {
  const file = readCompoundFile(bytes)
  const streams = STREAMS.map((name) => file.stream(name))
  if (!streams[0]) throw new Error('JTD has no DocumentText stream')
  const parts: string[] = []
  for (const stream of streams) {
    if (!stream) continue
    if (stream.toString('latin1', 0, SIGNATURE.length) !== SIGNATURE) {
      throw new Error('JTD text stream does not start with its signature')
    }
    const blocks = textBlocks(stream)
    // An older version marks no block: the whole stream, its text found by its markers
    const text = blocks.length
      ? blocks.map(([from, to]) => runs(stream, from, to, true)).join('\n')
      : runs(stream, SIGNATURE.length, stream.length, false)
    parts.push(text)
  }
  return parts
    .map((part) => part.split('\n').map(tidy).filter(mostlyText).join('\n'))
    .filter((part) => part.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

/** Each `TextV.01` block's units, as byte ranges of the stream. */
function textBlocks(stream: Buffer): [number, number][] {
  const blocks: [number, number][] = []
  for (let at = stream.indexOf(TEXT_BLOCK, 0, 'latin1'); at >= 0;) {
    const from = at + TEXT_BLOCK.length + 4
    if (from > stream.length) break
    const to = Math.min(stream.length, from + stream.readUInt32BE(at + TEXT_BLOCK.length) * 2)
    blocks.push([from, to])
    at = stream.indexOf(TEXT_BLOCK, Math.max(to, from), 'latin1')
  }
  return blocks
}

/**
 * The text of the stream's units from `from` to `to`, `inText` where text
 * starts there without a marker, as a block's does.
 */
function runs(stream: Buffer, from: number, to: number, inText: boolean): string {
  const end = from + Math.floor((to - from) / 2) * 2
  const unit = (at: number) => (at < end ? stream.readUInt16BE(at) : -1)
  const lines: string[] = []
  let line = ''
  let notes: string[] = []
  let text = inText
  const breakLine = () => {
    lines.push(notes.length ? `${line} ${notes.join(' ')}` : line)
    line = ''
    notes = []
  }
  for (let at = from; at < end; at += 2) {
    const u = unit(at)
    if (u === RECORD) {
      // A record: its kind, then its length in units from this one to the
      // `0x001F` it ends in. Its parameters may hold any value, a `0x001D` too
      const kind = unit(at + 2)
      const last = at + (unit(at + 4) - 1) * 2
      // A length that does not reach past the record's start is no record: read on
      if (last <= at) {
        text = false
      } else if (kind === INLINE_KIND && unit(last) === INLINE) {
        const close = inlineEnd(stream, last, end)
        if (close === undefined) {
          text = false
          at = last
          continue
        }
        const content = characters(stream, last + 2, close)
        if (unit(at + 8) === ANNOTATION) {
          if (content.trim()) notes.push(content.trim())
        } else line += content
        // After the inline, its own end: `0x001E`, its length, and the `0x001F`
        const tail = close + (unit(close + 2) - 1) * 2
        text = tail > close && unit(tail) === TEXT
        at = text ? tail : close
      } else if (unit(last) === TEXT) {
        // A record between runs of text stands for a cell's end, a tab
        line += '\t'
        at = last
        text = true
      } else {
        text = false
      }
    } else if (u === TEXT) {
      text = true
    } else if (u === 0x0009) {
      if (text) line += '\t'
    } else if (BREAKS.has(u)) {
      breakLine()
      if (u === 0x000c || u === 0x000e) text = false
    } else if (!printable(u)) {
      text = false
    } else if (text) {
      // A surrogate pair is two units, read together; a lone one is dropped
      if (u >= 0xd800 && u < 0xdc00) {
        const low = unit(at + 2)
        if (low >= 0xdc00 && low < 0xe000) {
          line += String.fromCharCode(u, low)
          at += 2
        }
      } else if (u < 0xdc00 || u >= 0xe000) line += String.fromCharCode(u)
    }
  }
  breakLine()
  return lines.join('\n')
}

/** Where the `0x001E` closing the inline at `at` is, within its bound; undefined where none is. */
function inlineEnd(stream: Buffer, at: number, end: number): number | undefined {
  const limit = Math.min(end, at + 2 + INLINE_MAX_UNITS * 2)
  for (let i = at + 2; i < limit; i += 2) {
    if (stream.readUInt16BE(i) === INLINE_END) return i
  }
  return undefined
}

/** Whether a unit is a character, not a control code or a noncharacter a parameter holds. */
function printable(u: number): boolean {
  return u >= 0x20 && !(u >= 0x7f && u < 0xa0) && u < 0xfffe
}

/** The characters of the units from `from` to `to`: a surrogate pair as one, what is not a character dropped. */
function characters(stream: Buffer, from: number, to: number): string {
  let out = ''
  for (let at = from; at < to; at += 2) {
    const u = stream.readUInt16BE(at)
    if (u >= 0xd800 && u < 0xdc00) {
      const low = at + 2 < to ? stream.readUInt16BE(at + 2) : 0
      if (low >= 0xdc00 && low < 0xe000) {
        out += String.fromCharCode(u, low)
        at += 2
      }
    } else if (printable(u) && (u < 0xdc00 || u >= 0xe000)) out += String.fromCharCode(u)
  }
  return out
}

/**
 * A line without the tabs records leave at its ends, and runs of them as one.
 * Trimmed by hand: `\t+$` tries each tab of a long run against the end in turn.
 */
function tidy(line: string): string {
  let start = 0
  let end = line.length
  while (start < end && line.charCodeAt(start) === 0x09) start++
  while (end > start && line.charCodeAt(end - 1) === 0x09) end--
  return line.slice(start, end).replace(/\t{2,}/g, '\t')
}

/**
 * Whether a line is text rather than formatting read as characters: most of
 * what is not white space in it is in the ranges Japanese text is written in.
 * By code point, not by script — `・` and `ー` are of no script.
 */
function mostlyText(line: string): boolean {
  let counted = 0
  let text = 0
  for (const c of line) {
    if (/\s/.test(c)) continue
    counted++
    if (JAPANESE_TEXT.test(c)) text++
  }
  return counted === 0 ? line === '' : text / counted >= TEXT_SHARE
}

/**
 * ASCII; punctuation, arrows, numbers in circles, box drawing and shapes;
 * CJK symbols, kana and kanji (with their extensions past the BMP); and the
 * full and half widths.
 */
const JAPANESE_TEXT =
  /[\u0021-\u007E\u2010-\u205E\u2100-\u23FF\u2460-\u27BF\u3000-\u30FF\u31F0-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]|[\uD840-\uD87F][\uDC00-\uDFFF]/
