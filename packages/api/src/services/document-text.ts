/**
 * Reading a document's text artifact back: the blocks the worker wrote, with
 * where each sits in the file (see `DocumentTextBlock`). What the resource page
 * shows beside the original, so that what extraction made of a file can be
 * seen and the extraction tuned, and the head of the text the suggestion and
 * the abstract are written from (ADR-040, ADR-053).
 */

import { createInterface } from 'node:readline'
import { pipeline } from 'node:stream'
import { createZstdDecompress } from 'node:zlib'
import type { StorageAdapter } from '@kukan/storage-adapter'
import {
  documentTextBlocks,
  type DocumentText,
  type DocumentTextBlock,
  type DocumentTextLoc,
} from '@kukan/shared'
import { truncateToByteLimit } from '@kukan/shared/encoding-node'

/** The artifact's lines as decompressed; what is left unread is not downloaded. */
async function* artifactLines(storage: StorageAdapter, key: string): AsyncGenerator<string> {
  const source = await storage.download(key)
  // pipeline, not pipe: a download that fails midway has to fail the read
  const lines = createInterface({
    input: pipeline(source, createZstdDecompress(), () => {}),
    crlfDelay: Infinity,
  })
  try {
    yield* lines
  } finally {
    lines.close()
    source.destroy()
  }
}

/**
 * The artifact's blocks, up to `limit` bytes of them as stored: the rest is
 * left unread, and `truncated` says there was more. Counted by the line rather
 * than the text, so a document of figures is bounded too; a block is never cut
 * — the one that crosses the limit is the last returned.
 */
export async function readDocumentText(
  storage: StorageAdapter,
  key: string,
  limit: number
): Promise<DocumentText> {
  let bytes = 0
  async function* counted() {
    for await (const line of artifactLines(storage, key)) {
      bytes += Buffer.byteLength(line, 'utf-8')
      yield line
    }
  }
  const blocks: DocumentTextBlock[] = []
  let full = false
  let truncated = false
  for await (const block of documentTextBlocks(counted())) {
    // Only a block past the limit says there was more
    if (full) {
      truncated = true
      break
    }
    blocks.push(block)
    full = bytes >= limit
  }
  return { blocks, truncated }
}

/** Which blocks a section is: both bounds and the heading, where given, have to hold. */
export interface SectionQuery {
  /** The first page, slide or sheet, 1-based. */
  from?: number
  /** The last, inclusive. */
  to?: number
  /** Part of a heading the block is under, of a path of them, or of its sheet's name. */
  heading?: string
}

/** Where a section's text resumes: the block's index in the artifact, and the offset in its text. */
export interface SectionPosition {
  block: number
  offset: number
}

export interface DocumentSectionPart {
  block: DocumentTextBlock
  /** The block's text from where this part starts, cut where the section is. */
  text: string
  /** Where in the block's text it starts: past 0, where the part before it ended. */
  offset: number
}

export interface DocumentSection {
  parts: DocumentSectionPart[]
  /** Where the rest of the section starts; null when this is all of it. */
  next: SectionPosition | null
  /**
   * Where no block matched, the range of the document's pages, slides or
   * sheets (null for a document without), so the caller can ask again.
   */
  unmatched?: { units: UnitRange | null }
}

/** The first and last page, slide or sheet. */
export interface UnitRange {
  min: number
  max: number
}

/** The page, slide or sheet a block is in; none for a document without (a DOCX). */
export function blockUnit(loc: DocumentTextLoc): number | undefined {
  return loc.page ?? loc.slide ?? loc.sheet
}

/** What {@link blockUnit} counts. */
export function unitKind(loc: DocumentTextLoc): UnitKind | undefined {
  if (loc.page !== undefined) return 'page'
  if (loc.slide !== undefined) return 'slide'
  if (loc.sheet !== undefined) return 'sheet'
  return undefined
}

export type UnitKind = 'page' | 'slide' | 'sheet'

/** Width and case folded, spaces dropped: a heading is matched as a reader would type it. */
function foldHeading(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
}

/**
 * The headings a block is under, as the outline lists them and a heading
 * selects them: a workbook's sheet, by its name or number, where it has none.
 */
function blockPath(block: DocumentTextBlock): string[] {
  if (block.headings?.length) return block.headings
  const { sheet, sheetName } = block.loc
  return sheet !== undefined ? [sheetName ?? `sheet ${sheet}`] : []
}

function matcher({ from, to, heading }: SectionQuery): (block: DocumentTextBlock) => boolean {
  const needle = heading ? foldHeading(heading) : ''
  return (block) => {
    if (from !== undefined || to !== undefined) {
      const unit = blockUnit(block.loc)
      if (unit === undefined) return false
      if (from !== undefined && unit < from) return false
      if (to !== undefined && unit > to) return false
    }
    if (!needle) return true
    // The path as well as each heading, so `A > B` can be given to pick B under A
    const path = blockPath(block)
    const names = [...path, path.join('>')]
    return names.some((name) => foldHeading(name).includes(needle))
  }
}

/**
 * Where to cut `text` to at most `max` characters: at the last line break in
 * its second half if there is one, so a line is not split; never between the
 * halves of a surrogate pair. Never 0, so a section always moves on.
 */
function cutAt(text: string, max: number): number {
  if (text.length <= max) return text.length
  const lineEnd = text.lastIndexOf('\n', max - 1)
  if (lineEnd >= max / 2) return lineEnd + 1
  const code = text.charCodeAt(max - 1)
  // A pair is kept whole even past the limit, rather than cut to nothing
  if (code >= 0xd800 && code <= 0xdbff) return max > 1 ? max - 1 : max + 1
  return max
}

/** The artifact's lines with its first `count` blocks left out unparsed. */
async function* skippingBlocks(lines: AsyncIterable<string>, count: number) {
  let header = true
  let skipped = 0
  for await (const line of lines) {
    if (!line) continue
    if (header) header = false
    else if (skipped < count) {
      skipped++
      continue
    }
    yield line
  }
}

/**
 * The blocks `query` selects, from `start`, up to `maxChars` characters of
 * their text — a block that crosses the limit is cut, and `next` says where it
 * resumes — or `maxBlocks` blocks, which bounds a run of pages with no text.
 * A figure without a description has nothing to read and is left out.
 *
 * The blocks are in the order of their pages, slides and sheets, so a range is
 * read up to its end and no further.
 */
export async function readDocumentSection(
  storage: StorageAdapter,
  key: string,
  query: SectionQuery,
  start: SectionPosition,
  { maxChars, maxBlocks }: { maxChars: number; maxBlocks: number }
): Promise<DocumentSection> {
  const matches = matcher(query)
  const parts: DocumentSectionPart[] = []
  let chars = 0
  let next: SectionPosition | null = null
  // A position past the start is one this section stopped at, so it matched
  let matched = start.block > 0
  let min = Infinity
  let max = -Infinity
  let index = start.block - 1
  const lines = skippingBlocks(artifactLines(storage, key), start.block)
  for await (const block of documentTextBlocks(lines)) {
    index++
    const unit = blockUnit(block.loc)
    if (matched && query.to !== undefined && unit !== undefined && unit > query.to) break
    if (!matched && unit !== undefined) {
      min = Math.min(min, unit)
      max = Math.max(max, unit)
    }
    if (!matches(block) || (block.figure && !block.text)) continue
    matched = true
    // The section is full and has more: this block is where it resumes
    if (chars >= maxChars || parts.length >= maxBlocks) {
      next = { block: index, offset: 0 }
      break
    }
    const offset = index === start.block ? start.offset : 0
    const rest = block.text.slice(offset)
    const cut = cutAt(rest, maxChars - chars)
    parts.push({ block, text: rest.slice(0, cut), offset })
    chars += cut
    if (cut < rest.length) {
      next = { block: index, offset: offset + cut }
      break
    }
  }
  if (matched) return { parts, next }
  return { parts, next, unmatched: { units: min <= max ? { min, max } : null } }
}

/** One heading of an outline, or a sheet of a workbook that has none. */
export interface OutlineEntry {
  /** 0 for a top-level heading. */
  depth: number
  title: string
  /** The pages, slides or sheets it spans; absent in a document without (a DOCX). */
  units?: UnitRange
  /** A sheet's rows, first and last. */
  rows?: UnitRange
}

export interface DocumentOutline {
  /** What the blocks read are in, and the first and last of them; null where none has one. */
  units: (UnitRange & { kind: UnitKind }) | null
  entries: OutlineEntry[]
  /** Pages whose text has to be read from their image (`unreadable`), as ranges. */
  unreadable: UnitRange[]
}

function widen(range: UnitRange | undefined, n: number): UnitRange {
  return range ? { min: Math.min(range.min, n), max: Math.max(range.max, n) } : { min: n, max: n }
}

/**
 * The headings of a document, with the pages each spans: a heading opens
 * where its path first differs from the block before, and runs while blocks
 * stay under it — the blocks a heading selects in {@link readDocumentSection}.
 * A block with no path (a cover, an untitled slide) closes them all.
 * Limited to the pages `from`–`to` where given; read to the end otherwise,
 * since the last heading's span and the page count are only known there.
 */
export async function readDocumentOutline(
  storage: StorageAdapter,
  key: string,
  { from, to }: { from?: number; to?: number }
): Promise<DocumentOutline> {
  const entries: OutlineEntry[] = []
  let units = null as DocumentOutline['units']
  const unreadable: UnitRange[] = []
  // The entries of the headings the last block was under, outermost first
  let open: OutlineEntry[] = []
  for await (const block of documentTextBlocks(artifactLines(storage, key))) {
    const unit = blockUnit(block.loc)
    if (unit !== undefined) {
      if (to !== undefined && unit > to) break
      if (from !== undefined && unit < from) continue
      units = { kind: units?.kind ?? unitKind(block.loc)!, ...widen(units ?? undefined, unit) }
      if (block.unreadable) {
        // In unit order, so a page either extends the last range or starts one
        const last = unreadable.at(-1)
        if (last && unit <= last.max + 1) last.max = unit
        else unreadable.push({ min: unit, max: unit })
      }
    }
    const path = blockPath(block)
    let same = 0
    while (same < open.length && same < path.length && open[same]!.title === path[same]) same++
    open = open.slice(0, same)
    for (let depth = same; depth < path.length; depth++) {
      const entry = { depth, title: path[depth]! }
      entries.push(entry)
      open.push(entry)
    }
    const rows = block.loc.sheet !== undefined ? block.loc.rows : undefined
    for (const entry of open) {
      if (unit !== undefined) entry.units = widen(entry.units, unit)
      if (rows?.length) entry.rows = widen(widen(entry.rows, rows[0]!), rows.at(-1)!)
    }
  }
  return { units, entries, unreadable }
}

/**
 * The first `limit` UTF-8 bytes of the text, a newline between the blocks
 * that have any; a character the cut splits is dropped.
 */
export async function readDocumentTextHead(
  storage: StorageAdapter,
  key: string,
  limit: number
): Promise<string> {
  const texts: string[] = []
  let bytes = 0
  for await (const { text } of documentTextBlocks(artifactLines(storage, key))) {
    if (!text) continue
    // The newline is before every block but the first
    bytes += Buffer.byteLength(text, 'utf-8') + (texts.length > 0 ? 1 : 0)
    texts.push(text)
    if (bytes >= limit) break
  }
  return truncateToByteLimit(texts.join('\n'), limit)
}
