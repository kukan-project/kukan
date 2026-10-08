/**
 * The text of a document file, a block at a time, written as the document text
 * artifact the Index step reads — without parsing the whole document at once,
 * which took gigabytes for megabytes of text (see PDF_RANGE_BYTES). PDFs go
 * through officeparser a range of pages at a time; XLSX sheets are read as a
 * stream of XML; the legacy Office formats — XLS, DOC, PPT — and Ichitaro by
 * readers of our own, as officeparser does not read them; other formats whole.
 *
 * Each block says where in the file its text is: the page, the slide, the
 * sheet and row, and the headings the file itself marks over it. A heading is
 * never inferred from how text looks — on the PDFs we tried, the font-size
 * guess made a decorative numeral a heading and a running header a chapter.
 */

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { readFile, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress } from 'node:zlib'
import { posix } from 'node:path'
import yauzl from 'yauzl'
import { SaxesParser, type SaxesTagPlain } from 'saxes'
import {
  decodePDFRawStream,
  ParseSpeeds,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  PDFHexString,
  type PDFObject,
} from '@cantoo/pdf-lib'
import {
  OfficeParser,
  type OfficeContentNode,
  type OfficeParserAST,
  type OfficeParserConfig,
} from 'officeparser'
import {
  DOCUMENT_TEXT_SCHEMA,
  type DocumentTextBlock,
  type DocumentTextFigure,
  type DocumentTextHeader,
  type DocumentTextLoc,
} from '@kukan/shared'
import {
  DOCUMENT_TEXT_MAX_BYTES,
  PDF_RANGE_BYTES,
  PDF_RANGE_MAX_PAGES,
  PDF_RANGE_MIN_PAGES,
  XLSX_MAX_ENTRIES,
  XLSX_MAX_PART_BYTES,
} from '@/config'
import { docText } from './legacy/doc'
import { jtdSheets } from './legacy/jtd'
import { pptSlides } from './legacy/ppt'
import { xlsSheets, type XlsRow } from './legacy/xls'

/**
 * Flowing text, not the v8 default: a PDF page rendered as a space-padded
 * monospace grid only inflates what we index and hand to the suggest side.
 * No pictures: each is a block of its own (`figureBlocks`), where rendered it
 * would add `[Image: description]` and have its description indexed twice.
 */
const TEXT_OPTIONS = { textConfig: { preserveLayout: false }, includeImages: 'none' } as const

/** What the text does not need: colours, and every node's coordinates. */
const PDF_TEXT_ONLY: OfficeParserConfig = {
  ignorePageGeometry: true,
  pdfParserConfig: { extractTextColor: false },
}

/** Characters of a heading kept; a "heading" longer than this is a paragraph styled as one. */
const HEADING_MAX_CHARS = 200

/** Characters of text a block holds at most; a longer run is written as several. */
const BLOCK_MAX_CHARS = 32_000

/** Pixels below which an image on either side is a bullet, a rule or an icon, not a figure. */
const FIGURE_MIN_PIXELS = 48

/** Hex digits of an image's digest kept: enough to tell a document's images apart. */
const FIGURE_DIGEST_CHARS = 16

export interface ExtractedText {
  /**
   * UTF-8 bytes of the text, a newline between the blocks that have any; 0
   * where no block has more than white space in it, which is how a document
   * with no text is told apart.
   */
  bytes: number
}

/**
 * Write the text of the document at `filePath` to `artifactPath` as zstd
 * NDJSON, reading it another way where the first fails (`fallbackBlocks`).
 */
export async function extractDocumentText(
  filePath: string,
  format: string,
  artifactPath: string
): Promise<ExtractedText> {
  try {
    return await writeBlocks(documentBlocks(filePath, format), artifactPath)
  } catch (err) {
    const fallback = fallbackBlocks(format)
    if (!fallback) throw err
    return writeBlocks(fallback(filePath), artifactPath)
  }
}

/** Write the header, then `blocks`, a JSON value per line, through zstd. */
async function writeBlocks(
  blocks: AsyncIterable<DocumentTextBlock>,
  path: string
): Promise<ExtractedText> {
  const zstd = createZstdCompress()
  const written = pipeline(zstd, createWriteStream(path))
  // Handled from the start: a write that fails while blocks are still being
  // read is awaited below, and ends the wait for a 'drain' that will not come
  written.catch(() => {})
  const put = async (value: DocumentTextHeader | DocumentTextBlock) => {
    if (!zstd.write(JSON.stringify(value) + '\n'))
      await Promise.race([once(zstd, 'drain'), written])
  }
  let hasText = false
  let bytes = 0
  let joined = 0
  try {
    await put({ schema: DOCUMENT_TEXT_SCHEMA })
    for await (const block of blocks) {
      const whole = cleaned(block)
      if (whole.text) {
        bytes += Buffer.byteLength(whole.text, 'utf-8') + (joined++ > 0 ? 1 : 0)
        if (bytes > DOCUMENT_TEXT_MAX_BYTES) {
          throw new Error(`Document text is over ${DOCUMENT_TEXT_MAX_BYTES} bytes`)
        }
        if (!hasText && whole.text.trim()) hasText = true
      }
      for (const block of bounded(whole)) await put(block)
    }
    zstd.end()
  } catch (err) {
    zstd.destroy(err as Error)
    await written.catch(() => {})
    throw err
  }
  await written
  return { bytes: hasText ? bytes : 0 }
}

/**
 * Characters a text extractor gives that no reader means: control characters
 * (C0 and C1) a font's glyph numbers came out as, and the Kangxi radicals (U+2F00) a PDF
 * font maps its ideographs to — `⽇` for `日`, which look the same and search
 * as different words.
 */
// eslint-disable-next-line no-control-regex -- matching them is what it is for
const STRAY_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2E80-\u2FDF]/g

function cleanText(text: string): string {
  return text.replace(STRAY_CHARACTERS, (c) => (c < '\u00A0' ? ' ' : c.normalize('NFKC')))
}

function cleaned(block: DocumentTextBlock): DocumentTextBlock {
  return {
    ...block,
    ...(block.headings && { headings: block.headings.map(cleanText) }),
    text: cleanText(block.text),
  }
}

/**
 * `block`, as blocks of at most BLOCK_MAX_CHARS, split between lines where
 * there is one to split at. A section of a document with no headings is the
 * whole document, and a line of that length is what every reader of the
 * artifact would otherwise have to hold and split.
 */
function* bounded(block: DocumentTextBlock): Generator<DocumentTextBlock> {
  let rest = block.text
  while (rest.length > BLOCK_MAX_CHARS) {
    const newline = rest.lastIndexOf('\n', BLOCK_MAX_CHARS)
    const cut = newline > 0 ? newline : characterBoundary(rest, BLOCK_MAX_CHARS)
    yield { ...block, text: rest.slice(0, cut) }
    rest = rest.slice(newline > 0 ? cut + 1 : cut)
  }
  yield { ...block, text: rest }
}

/**
 * `at`, or one before it where `at` would split a surrogate pair — an emoji
 * or a kanji outside the BMP, which cut reads as two U+FFFD.
 */
function characterBoundary(text: string, at: number): number {
  const before = text.charCodeAt(at - 1)
  return before >= 0xd800 && before <= 0xdbff ? at - 1 : at
}

export async function* documentBlocks(
  filePath: string,
  format: string
): AsyncGenerator<DocumentTextBlock> {
  if (format === 'pdf') yield* pdfBlocks(filePath)
  else if (format === 'xlsx') yield* xlsxBlocks(filePath)
  else if (format === 'xls') yield* xlsBlocks(filePath)
  else if (format === 'doc') yield* docBlocks(filePath)
  else if (format === 'ppt') yield* pptBlocks(filePath)
  else if (format === 'jtd' || format === 'jtt') yield* jtdBlocks(filePath)
  else yield* officeBlocks(filePath)
}

/**
 * Another way to read `format` when `documentBlocks` fails partway, or none.
 * An XLSX the strict XML reader refuses may be one officeparser reads, at its
 * cost in memory; it cannot take back what it yielded, so the caller restarts.
 */
function fallbackBlocks(
  format: string
): ((filePath: string) => AsyncGenerator<DocumentTextBlock>) | undefined {
  return format === 'xlsx' ? officeBlocks : undefined
}

/**
 * `nodes` of `ast` as text, rendered as the whole document would render them.
 * Without the document-wide lists — the outline, headers, slide masters,
 * attachments — which text never shows and every call would walk again.
 */
async function render(ast: OfficeParserAST, nodes?: OfficeContentNode[]): Promise<string> {
  const part = nodes ? { ...ast, content: nodes, auxiliary: undefined, attachments: [] } : ast
  return (await ast.to.call(part, 'text', TEXT_OPTIONS)).value
}

function headingText(node: OfficeContentNode): string {
  return oneHeading(node.text ?? '')
}

function oneHeading(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, HEADING_MAX_CHARS)
}

/**
 * A slide or a sheet a block each; anything else in runs from one heading to
 * the next, under the path of headings that leads to it. The headings are the
 * document's own: Word's heading styles, a slide's title placeholder. Each
 * run's pictures follow it.
 */
async function* officeBlocks(filePath: string): AsyncGenerator<DocumentTextBlock> {
  const ast = await OfficeParser.parseOffice(filePath)
  const top = ast.content ?? []
  if (top.length === 0) {
    yield { loc: {}, text: await render(ast) }
    return
  }
  const partOf = packageParts(filePath)
  const path: { level: number; title: string }[] = []
  let run: OfficeContentNode[] = []
  async function* section(): AsyncGenerator<DocumentTextBlock> {
    if (run.length === 0) return
    const nodes = run
    run = []
    const under = headingsOf(path.map((h) => h.title))
    yield { loc: {}, ...under, text: await render(ast, nodes) }
    yield* figureBlocks(nodes, {}, under, partOf)
  }
  let sheets = 0
  for (const node of top) {
    if (node.type === 'slide' || node.type === 'sheet') {
      yield* section()
      yield* unitBlocks(ast, node, partOf, node.type === 'sheet' ? ++sheets : undefined)
      continue
    }
    if (node.type === 'heading') {
      yield* section()
      const level = (node.metadata as { level?: number } | undefined)?.level ?? 1
      const title = headingText(node)
      while (path.length > 0 && path[path.length - 1].level >= level) path.pop()
      if (title) path.push({ level, title })
    }
    run.push(node)
  }
  yield* section()
}

/** A slide under its title, or a sheet by its number and name, and then its pictures. */
async function* unitBlocks(
  ast: OfficeParserAST,
  node: OfficeContentNode,
  partOf: (name: string) => Promise<string>,
  /** The sheet's number, where `node` is one. */
  sheet?: number
): AsyncGenerator<DocumentTextBlock> {
  const meta = node.metadata as { sheetName?: string; slideNumber?: number } | undefined
  let loc: DocumentTextLoc = {}
  let under: { headings?: string[] } = {}
  if (sheet !== undefined) {
    loc = { sheet, ...(meta?.sheetName && { sheetName: meta.sheetName }) }
  } else {
    if (meta?.slideNumber !== undefined) loc = { slide: meta.slideNumber }
    const title = findNodes(node, (n) => n.type === 'heading')[0]
    const text = title ? headingText(title) : ''
    under = headingsOf(text ? [text] : undefined)
  }
  yield { loc, ...under, text: await render(ast, [node]) }
  yield* figureBlocks([node], loc, under, partOf)
}

/** Each picture in `nodes`, its author's description as its text. */
async function* figureBlocks(
  nodes: OfficeContentNode[],
  loc: DocumentTextLoc,
  under: { headings?: string[] },
  partOf: (name: string) => Promise<string>
): AsyncGenerator<DocumentTextBlock> {
  for (const image of nodes.flatMap((node) => findNodes(node, (n) => n.type === 'image'))) {
    const meta = image.metadata as { attachmentName?: string; altText?: string } | undefined
    if (!meta?.attachmentName) continue
    yield {
      loc,
      ...under,
      text: (meta.altText ?? '').trim(),
      figure: { ref: await partOf(meta.attachmentName) },
    }
  }
}

/**
 * A picture's part in its package, from the name officeparser gives it: a
 * path, or — for PPTX — the file name alone, looked up among the package's
 * entries the first time one is asked for.
 */
function packageParts(filePath: string): (name: string) => Promise<string> {
  let parts: Promise<Map<string, string>> | undefined
  return async (name) => {
    if (name.includes('/')) return name.replace(/^\//, '')
    parts ??= partsByFileName(filePath)
    return (await parts).get(name) ?? name
  }
}

/** A package's entries by file name; a picture's media folder wins a clash. */
async function partsByFileName(filePath: string): Promise<Map<string, string>> {
  const parts = new Map<string, string>()
  try {
    const zip = await openZip(filePath)
    try {
      for (const entry of (await listEntries(zip)).keys()) {
        const name = posix.basename(entry)
        if (!parts.has(name) || entry.includes('/media/')) parts.set(name, entry)
      }
    } finally {
      zip.close()
    }
  } catch {
    // Not a package: names stay as officeparser gave them
  }
  return parts
}

function findNodes(
  node: OfficeContentNode,
  match: (n: OfficeContentNode) => boolean
): OfficeContentNode[] {
  return [
    ...(match(node) ? [node] : []),
    ...(node.children ?? []).flatMap((child) => findNodes(child, match)),
  ]
}

/** `{ headings }` where there are any: a block with none leaves the key out. */
function headingsOf(headings: string[] | undefined): { headings?: string[] } {
  return headings && headings.length > 0 ? { headings } : {}
}

/**
 * A range of pages at a time, sized by the file's bytes per page. The first
 * range is the smallest, and says how many pages there are.
 */
async function* pdfBlocks(filePath: string): AsyncGenerator<DocumentTextBlock> {
  const { size } = await stat(filePath)
  let first = 1
  let count = PDF_RANGE_MIN_PAGES
  let pages = Infinity
  let bookmarks: Bookmarks | undefined
  const facts = await pdfPageFacts(filePath)
  while (first <= pages) {
    const last = Math.min(first + count - 1, pages)
    const ast = await OfficeParser.parseOffice(filePath, {
      ...PDF_TEXT_ONLY,
      pdfParserConfig: { ...PDF_TEXT_ONLY.pdfParserConfig, pageRange: `${first}-${last}` },
    })
    const total = ast.metadata?.pages
    if (typeof total !== 'number') {
      // Without the page count, ranges cannot be walked: read it whole, as before
      const whole = await OfficeParser.parseOffice(filePath, PDF_TEXT_ONLY)
      yield* pageBlocks(whole, new Bookmarks(whole.auxiliary?.outline), facts)
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
    // Every range carries the whole outline, so the first one's will do
    bookmarks ??= new Bookmarks(ast.auxiliary?.outline)
    yield* pageBlocks(ast, bookmarks, facts)
  }
}

/**
 * A block per page, then the page's images: empty for a page with no text on
 * it, marked for one whose text is mostly in fonts it cannot be read from, and
 * with the count of what was left out of one with any.
 */
async function* pageBlocks(
  ast: OfficeParserAST,
  bookmarks: Bookmarks,
  { figures, fonts }: PdfPageFacts
): AsyncGenerator<DocumentTextBlock> {
  const pages = (ast.content ?? []).filter((node) => node.type === 'page')
  if (pages.length === 0) {
    const text = await render(ast)
    if (text) yield { loc: {}, text }
    return
  }
  for (const page of pages) {
    const meta = page.metadata as { pageNumber?: number; pageLabel?: string } | undefined
    const read = readable(page, fonts.get(meta?.pageNumber ?? 0))
    const text = await render(ast, read.page ? [read.page] : [])
    const under = headingsOf(
      meta?.pageNumber ? bookmarks.at(meta.pageNumber, anchorsOn(page)) : undefined
    )
    const loc = {
      ...(meta?.pageNumber !== undefined && { page: meta.pageNumber }),
      ...(meta?.pageLabel && { label: meta.pageLabel }),
    }
    yield {
      loc,
      ...under,
      text,
      ...(read.lost > read.kept
        ? { unreadable: 'unmapped-fonts' as const }
        : !text.trim() && { unreadable: 'no-text' as const }),
      ...(read.lost > 0 && { unmappedChars: read.lost }),
    }
    for (const figure of figures.get(meta?.pageNumber ?? 0) ?? []) {
      yield { loc, ...under, text: '', figure }
    }
  }
}

/**
 * What each page of a PDF draws, from its content and resources: its images —
 * which object, its size in pixels, and a digest of its bytes as stored, none
 * of it decoded, which is what extracting them through officeparser costs
 * (several times the text's time, and PNGs larger than the PDF) — and the
 * fonts it sets text in. Loading the file whole costs about 1.6 times its
 * size, gone before the text is parsed: 87MB and 0.2s for a 54MB PDF of 226
 * pages.
 *
 * pdf-lib reads the page tree strictly where officeparser reads the text
 * leniently: nothing where it will not load the file, and nothing for a page
 * it cannot read. The text is read without them, its fonts unjudged.
 */
async function pdfPageFacts(filePath: string): Promise<PdfPageFacts> {
  const figures = new Map<number, DocumentTextFigure[]>()
  const fonts = new Map<number, PageFonts>()
  try {
    const doc = await PDFDocument.load(await readFile(filePath), {
      updateMetadata: false,
      // Decrypted with the empty user password: a PDF any viewer opens, whose
      // permissions forbid copying its text, as a sixth of the ones we tried
      // do. Encrypted, its content is ciphertext and the objects in its
      // streams unreadable: upstream pdf-lib cannot decrypt, this fork can.
      // It parses such a file twice, holding the first parse through the
      // second — twice the memory, for those files only. One it cannot
      // decrypt (a trailer without the /ID its key is made from) gives nothing
      password: '',
      // Its default yields to the event loop every 100 objects, which in a
      // process doing nothing else is only waiting
      parseSpeed: ParseSpeeds.Fastest,
    })
    // Per object rather than per page: a decoration drawn on every page, or a
    // font every page uses, is looked at once
    const walk: PdfWalk = {
      doc,
      forms: new Map(),
      inheriting: new WeakMap(),
      fonts: new Map(),
      opening: new Set(),
    }
    doc.getPages().forEach((page, i) => {
      try {
        const found = drawnBy(walk, page.node.Resources(), pageContents(doc, page.node.Contents()))
        // An image the page draws twice, or through two forms, is one figure
        const distinct = [...new Map(found.figures.map((f) => [f.ref, f])).values()]
        if (distinct.length > 0) figures.set(i + 1, distinct)
        if (found.judged) fonts.set(i + 1, found)
      } catch {
        // Nothing for this page: no figures, its fonts unjudged
      }
    })
  } catch {
    // Nothing at all
  }
  return { figures, fonts }
}

interface PdfPageFacts {
  figures: Map<number, DocumentTextFigure[]>
  /** Only for the pages that set text in a font whose codes are its glyph numbers */
  fonts: Map<number, PageFonts>
}

/**
 * The characters a font's text can hold: those its ToUnicode maps its codes
 * to, and where `encoded`, those an encoding of a simple font gives
 * ({@link ENCODED}); null where it can hold any.
 */
type FontCharacters = { mapped: ReadonlySet<string>; encoded: boolean } | null

/**
 * The fonts a page sets text in, by name, by what their text can hold: of two
 * fonts of one name, what either can. `judged` where one is a font whose
 * codes are its glyph numbers, which is all that can give a character none
 * of them maps.
 */
interface PageFonts {
  byName: Map<string, FontCharacters>
  /** What the fonts whose runs can carry any name hold (`FontFacts.anyName`) */
  anyName?: FontCharacters
  judged: boolean
}

/** What a content stream draws, through the forms it draws too. */
interface Drawn extends PageFonts {
  figures: DocumentTextFigure[]
}

/** One document's walk, and what it has found of the objects pages share. */
interface PdfWalk {
  doc: PDFDocument
  /** What each image is, and each form with resources of its own draws, by its object */
  forms: Map<string, Drawn>
  /**
   * What each form with none draws, by the resources it is drawn from — a form
   * two pages draw is two forms where their fonts differ — and its object
   */
  inheriting: WeakMap<PDFDict, Map<string, Drawn>>
  /** Each font's facts, by its object */
  fonts: Map<string, FontFacts>
  /** The forms being walked, so one that draws itself ends */
  opening: Set<string>
}

/**
 * What `contents` draw from a resource dictionary. The contents are read only
 * where the dictionary names an XObject or a font whose codes are its glyph
 * numbers: a page of text in other fonts has nothing in it to look for, and
 * inflating it would be work for nothing. Its fonts are then all the ones it
 * names, which only ever keep text.
 */
function drawnBy(walk: PdfWalk, resources: PDFDict | undefined, contents: PDFRawStream[]): Drawn {
  const drawn: Drawn = { figures: [], byName: new Map(), judged: false }
  const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict)
  const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict)
  const named = (fonts?.entries() ?? []).map(
    ([name, value]) => [name, fontFactsOf(walk, value)] as const
  )
  const add = ({ names, characters, glyphNumbers, anyName }: FontFacts) => {
    if (characters === 'none') return
    names.forEach((name) => addFont(drawn.byName, name, characters))
    if (anyName) drawn.anyName = eitherFont(drawn.anyName, characters)
    drawn.judged ||= glyphNumbers
  }
  if (!xobjects?.entries().length && !named.some(([, facts]) => facts.glyphNumbers)) {
    named.forEach(([, facts]) => add(facts))
    return drawn
  }
  const used = namesUsedBy(contents)
  // Set is not named: pages share one dictionary of every font and image in it
  for (const [name, facts] of named) if (used.fonts.has(name)) add(facts)
  for (const [name, value] of xobjects?.entries() ?? []) {
    if (!used.xobjects.has(name) || !(value instanceof PDFRef)) continue
    const inner = xobjectDrawn(walk, value, resources)
    drawn.figures.push(...inner.figures)
    inner.byName.forEach((characters, font) => addFont(drawn.byName, font, characters))
    if (inner.anyName !== undefined) drawn.anyName = eitherFont(drawn.anyName, inner.anyName)
    drawn.judged ||= inner.judged
  }
  return drawn
}

/** `font` added to the fonts of its name: their text holds what either's can. */
function addFont(byName: Map<string, FontCharacters>, font: string, characters: FontCharacters) {
  byName.set(font, eitherFont(byName.get(font), characters))
}

/** What either font's text can hold; the second's where there is no first. */
function eitherFont(a: FontCharacters | undefined, b: FontCharacters): FontCharacters {
  if (a === undefined) return b
  if (a === null || b === null) return null
  const mapped =
    a.mapped === b.mapped || b.mapped.size === 0
      ? a.mapped
      : a.mapped.size === 0
        ? b.mapped
        : new Set([...a.mapped, ...b.mapped])
  return { mapped, encoded: a.encoded || b.encoded }
}

const NOTHING: Drawn = { figures: [], byName: new Map(), judged: false }

/**
 * The figure an XObject is, or what a form XObject draws — from its own
 * resources, or those it is drawn from where it has none.
 */
function xobjectDrawn(walk: PdfWalk, ref: PDFRef, inherited: PDFDict | undefined): Drawn {
  const key = ref.toString()
  const stream = walk.doc.context.lookup(ref)
  if (!(stream instanceof PDFRawStream)) return NOTHING
  const subtype = stream.dict.get(PDFName.of('Subtype'))
  if (subtype === PDFName.of('Image')) {
    const known = walk.forms.get(key)
    if (known) return known
    const figure = figureOf(stream, key)
    const drawn = { ...NOTHING, figures: figure ? [figure] : [] }
    walk.forms.set(key, drawn)
    return drawn
  }
  if (subtype !== PDFName.of('Form')) return NOTHING
  const own = stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict)
  let forms = walk.forms
  if (!own && inherited) {
    forms = walk.inheriting.get(inherited) ?? new Map()
    walk.inheriting.set(inherited, forms)
  }
  const known = forms.get(key)
  if (known) return known
  // A form that draws itself
  if (walk.opening.has(key)) return NOTHING
  walk.opening.add(key)
  const drawn = drawnBy(walk, own ?? inherited, [stream])
  walk.opening.delete(key)
  forms.set(key, drawn)
  return drawn
}

/** An image XObject as a figure, unless too small for one. */
function figureOf(stream: PDFRawStream, ref: string): DocumentTextFigure | undefined {
  const width = stream.dict.lookupMaybe(PDFName.of('Width'), PDFNumber)?.asNumber()
  const height = stream.dict.lookupMaybe(PDFName.of('Height'), PDFNumber)?.asNumber()
  if (
    width !== undefined &&
    height !== undefined &&
    (width < FIGURE_MIN_PIXELS || height < FIGURE_MIN_PIXELS)
  ) {
    return undefined
  }
  const digest = createHash('sha256').update(stream.getContents()).digest('hex')
  return {
    ref,
    ...(width !== undefined && { width }),
    ...(height !== undefined && { height }),
    digest: digest.slice(0, FIGURE_DIGEST_CHARS),
  }
}

/** A page's content streams: one, or an array of them. */
function pageContents(doc: PDFDocument, contents: PDFObject | undefined): PDFRawStream[] {
  const parts = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : []
  return parts
    .map((part) => doc.context.lookup(part))
    .filter((part): part is PDFRawStream => part instanceof PDFRawStream)
}

/**
 * The XObjects `streams` paint (`/Name Do`) and the fonts they set text in
 * (`/Name size Tf`), named as pdf-lib names them — it reads their `#xx`
 * escapes as its parser read the dictionary's, and interns them, so the two
 * compare as they are. Read from the operators as text: a name inside a
 * string that happens to read `/X Do` counts, which costs at most an object
 * that was named anyway.
 */
function namesUsedBy(streams: PDFRawStream[]): { xobjects: Set<PDFName>; fonts: Set<PDFName> } {
  const xobjects = new Set<PDFName>()
  const fonts = new Set<PDFName>()
  for (const stream of streams) {
    const decoded = decodePDFRawStream(stream).decode()
    const operators = Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength)
    for (const [, name, operator] of operators
      .toString('latin1')
      .matchAll(/\/([^\s/[\]()<>{}%]+)\s+(?:[-+.\d]+\s+)?(Do|Tf)\b/g)) {
      ;(operator === 'Do' ? xobjects : fonts).add(PDFName.of(name))
    }
  }
  return { xobjects, fonts }
}

/** The names pdf.js may give a font, and what text pdf.js gives for it. */
interface FontFacts {
  names: string[]
  /** What its text can hold; none where pdf.js gives no text for it */
  characters: FontCharacters | 'none'
  /** Whether its codes are its glyph numbers, a glyph it does not map given as its number */
  glyphNumbers: boolean
  /**
   * A composite font the file does not embed, whose runs officeparser can
   * give under another font's name: pdf.js stands one of its own in for it
   */
  anyName?: boolean
}

/** The tag a subset font's name starts with (`ACJJEK+MS-Mincho`), which officeparser drops. */
const SUBSET_TAG = /^[A-Z]{6}\+/

/** The character collections pdf.js maps to Unicode by their own tables. */
const ADOBE_COLLECTIONS = new Set(['Japan1', 'GB1', 'CNS1', 'Korea1'])

/**
 * The facts of the font `value` is; any characters, with no name, where
 * pdf-lib cannot read it, so its text is kept.
 *
 * A composite font whose codes are its glyph numbers (Identity-H or -V) has
 * them given by pdf.js as the character of that number wherever its
 * ToUnicode does not say what character the glyph is — `の` as Samaritan `ࡢ`
 * (U+0862) — and no font on the reader's side makes it read. Without a
 * ToUnicode that is all of its text; a Ghostscript-made PDF has one that
 * leaves glyphs out, its `年` read as `ᖺ` (U+15BA) on a line whose other
 * glyphs read right. Either way its text can hold only what the map gives.
 * Such a font numbering its glyphs as one of Adobe's character collections
 * (Adobe-Japan1 and the like) has its codes looked up in pdf.js's CMaps: when
 * it is given them, which officeparser does not do, and without them pdf.js
 * gives no text for it at all.
 *
 * A simple font with a ToUnicode has what it leaves out given by its encoding
 * ({@link ENCODED}); one whose encoding names glyphs of its own
 * (`Differences`), or with no ToUnicode, or of symbols, can give any.
 */
function fontFactsOf(walk: PdfWalk, value: PDFObject): FontFacts {
  const key = value instanceof PDFRef ? value.toString() : undefined
  const known = key && walk.fonts.get(key)
  if (known) return known
  let facts: FontFacts = { names: [], characters: null, glyphNumbers: false }
  try {
    const font = walk.doc.context.lookup(value, PDFDict)
    const descendant = font
      .lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)
      ?.lookupMaybe(0, PDFDict)
    const names = pdfjsNames(descendant ?? font, descendant !== undefined)
    const subtype = font.get(PDFName.of('Subtype'))
    const encoding = font.lookup(PDFName.of('Encoding'))
    const toUnicode = font.lookup(PDFName.of('ToUnicode'))
    // A ToUnicode that names a CMap, or that cannot be read, is no measure
    const mapped =
      toUnicode instanceof PDFRawStream
        ? toUnicodeCharacters(toUnicode)
        : toUnicode
          ? undefined
          : NO_TEXT
    if (
      subtype === PDFName.of('Type0') &&
      (encoding === PDFName.of('Identity-H') || encoding === PDFName.of('Identity-V'))
    ) {
      const none = !toUnicode && inAdobeCollection(descendant)
      facts = {
        names,
        characters: none ? 'none' : mapped ? { mapped, encoded: false } : null,
        glyphNumbers: !none && mapped !== undefined,
        ...(!embedded(descendant) && { anyName: true }),
      }
    } else if (subtype === PDFName.of('Type0')) {
      facts = { names, characters: null, glyphNumbers: false, anyName: !embedded(descendant) }
    } else {
      const simple =
        subtype !== PDFName.of('Type3') &&
        toUnicode instanceof PDFRawStream &&
        !(encoding instanceof PDFDict && encoding.has(PDFName.of('Differences'))) &&
        !names.some((name) => SYMBOL_FONT.test(name))
      facts = {
        names,
        characters: simple && mapped ? { mapped, encoded: true } : null,
        glyphNumbers: false,
      }
    }
  } catch {
    // Not a font pdf-lib reads
  }
  if (key) walk.fonts.set(key, facts)
  return facts
}

const NO_TEXT: ReadonlySet<string> = new Set()

function embedded(font: PDFDict | undefined): boolean {
  const descriptor = font?.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict)
  return ['FontFile', 'FontFile2', 'FontFile3'].some((key) => descriptor?.has(PDFName.of(key)))
}

/**
 * The names pdf.js gives a font (`translateFont`), less the subset tag as
 * officeparser gives them: a composite font's descendant's, not the
 * composite's own, which has the CMap after it (`MS-Mincho-Identity-H`).
 * A simple font with no descriptor — one of the standard 14 — by its
 * BaseFont as pdf.js normalises it. Otherwise its descriptor's FontName,
 * unless it is missing, or the BaseFont is it and more (`Lato` and
 * `Lato-Medium`); where they differ otherwise, pdf.js picks by whether it
 * knows either name, from tables of its own, so both are given.
 */
function pdfjsNames(dict: PDFDict, composite: boolean): string[] {
  const descriptor = dict.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict)
  const base = dict.lookupMaybe(PDFName.of('BaseFont'), PDFName)?.decodeText()
  const fontName = descriptor?.lookupMaybe(PDFName.of('FontName'), PDFName)?.decodeText()
  let names: (string | undefined)[]
  if (!descriptor && !composite) names = [base?.replaceAll(/[,_]/g, '-').replaceAll(/\s/g, '')]
  else if (!fontName || !base || fontName === base) names = [fontName ?? base]
  else if (base.startsWith(fontName)) names = [base]
  else names = [fontName, base]
  return names.filter((name) => name !== undefined).map(runFont)
}

/**
 * A font's name as a run is judged by: less the subset tag, which officeparser
 * drops, and a `+1` it adds to tell two of a name apart — or the font's own
 * name has (`MS-Mincho+1`).
 */
const runFont = (name: string) => name.replace(SUBSET_TAG, '').replace(/\+\d+$/, '')

function inAdobeCollection(descendant: PDFDict | undefined): boolean {
  const info = descendant?.lookupMaybe(PDFName.of('CIDSystemInfo'), PDFDict)
  const text = (key: string) => {
    const value = info?.lookup(PDFName.of(key))
    return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : ''
  }
  return text('Registry') === 'Adobe' && ADOBE_COLLECTIONS.has(text('Ordering'))
}

/**
 * Codes a ToUnicode can map: all two bytes can be. One that maps more, by
 * ranges or entries that repeat, is not one a writer made, and is not read.
 */
const TO_UNICODE_MAX_CODES = 65_536

/** UTF-16 units a code's value can have: a ligature, or a few characters, not a text. */
const TO_UNICODE_MAX_VALUE_UNITS = 16

/**
 * A token of a CMap: a string's bytes, as hex digits, whether written in hex
 * (`<3042>`) or literally (`(0B)`); or any other word, `[` and `]` among them.
 */
type CMapToken = { hex: string } | { word: string }

/** What a literal string's escapes stand for, but the octal ones and a line break. */
const STRING_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }

/** Where a word of a CMap ends: white space, or a delimiter. */
const CMAP_DELIMITER = /[\s()<>[\]{}/%]/

/**
 * A CMap's tokens, read once from its start to its end, so that what it costs
 * is its length, whatever it holds: white space and comments (`%` to the end
 * of the line) passed over, and strings read as PDF reads them — a literal
 * one's parentheses nested and its escapes taken (`\060` for `0`), as pdf.js
 * reads `bfchar` entries written so. None where a string does not end, or a
 * hex string has more than hex digits in it.
 */
function cmapTokens(cmap: string): CMapToken[] | undefined {
  const tokens: CMapToken[] = []
  let i = 0
  while (i < cmap.length) {
    const c = cmap[i]!
    if (/\s/.test(c)) {
      i++
    } else if (c === '%') {
      while (i < cmap.length && cmap[i] !== '\n' && cmap[i] !== '\r') i++
    } else if (c === '(') {
      let bytes = ''
      let depth = 1
      i++
      while (i < cmap.length) {
        const ch = cmap[i]!
        if (ch === '\\') {
          const octal = /^[0-7]{1,3}/.exec(cmap.slice(i + 1, i + 4))?.[0]
          const next = cmap[i + 1]
          if (octal) bytes += String.fromCharCode(parseInt(octal, 8) & 0xff)
          // A backslash before a line break continues the string on the next line
          else if (next === '\r' && cmap[i + 2] === '\n') i++
          else if (next !== '\r' && next !== '\n') bytes += STRING_ESCAPES[next!] ?? next ?? ''
          i += 2 + (octal ? octal.length - 1 : 0)
          continue
        }
        if (ch === '(') depth++
        else if (ch === ')' && --depth === 0) break
        bytes += ch
        i++
      }
      if (depth > 0) return undefined
      tokens.push({ hex: Buffer.from(bytes, 'latin1').toString('hex') })
      i++
    } else if (c === '<' && cmap[i + 1] !== '<') {
      const close = cmap.indexOf('>', i)
      if (close < 0) return undefined
      const hex = cmap.slice(i + 1, close).replace(/\s/g, '')
      if (!/^[\dA-Fa-f]*$/.test(hex)) return undefined
      // An odd digit at the end is followed by a 0, as PDF reads it: `<4E0>` is `<4E00>`
      tokens.push({ hex: hex.length % 2 ? `${hex}0` : hex })
      i = close + 1
    } else if ('<>[]{}'.includes(c)) {
      const pair = (c === '<' || c === '>') && cmap[i + 1] === c
      tokens.push({ word: pair ? c + c : c })
      i += pair ? 2 : 1
    } else {
      let end = i + 1
      while (end < cmap.length && !CMAP_DELIMITER.test(cmap[end]!)) end++
      tokens.push({ word: cmap.slice(i, end) })
      i = end
    }
  }
  return tokens
}

/**
 * The characters a ToUnicode maps codes to, and those pdf.js gives for them:
 * its `normalizeUnicode` takes a ligature or a compatibility form to their
 * NFKC form, but for `ﬅ`, which it gives as `ſt`. Every value's NFKC form
 * is more than it gives, which only keeps more. None where it maps more
 * codes than {@link TO_UNICODE_MAX_CODES}, or a value longer than
 * {@link TO_UNICODE_MAX_VALUE_UNITS}, or takes another CMap in (`usecmap`) —
 * where what it leaves out cannot be told; nor where a `bfchar` or `bfrange`
 * holds anything that is not an entry, or does not end, for an entry left
 * unread would have the characters it maps taken out of the text. Bounded
 * so: the CMap is read once (`cmapTokens`), what each code costs is fixed,
 * and the codes are counted, not the characters they come to.
 */
function toUnicodeCharacters(stream: PDFRawStream): ReadonlySet<string> | undefined {
  let tokens: CMapToken[] | undefined
  try {
    const decoded = decodePDFRawStream(stream).decode()
    tokens = cmapTokens(
      Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength).toString('latin1')
    )
  } catch {
    return undefined
  }
  if (!tokens) return undefined
  const characters = new Set<string>()
  let codes = 0
  /** The characters of a code's value added; false where the map is past its bounds. */
  const add = (units: number[]): boolean => {
    if (++codes > TO_UNICODE_MAX_CODES || units.length > TO_UNICODE_MAX_VALUE_UNITS) return false
    const text = String.fromCharCode(...units)
    for (const c of text) characters.add(c)
    for (const c of text.normalize('NFKC')) characters.add(c)
    for (const c of text.replaceAll('\uFB05', 'ſt')) characters.add(c)
    return true
  }
  const hexOf = (token: CMapToken | undefined) => (token && 'hex' in token ? token.hex : undefined)
  const isWord = (token: CMapToken, word: string) => 'word' in token && token.word === word
  let section: 'bfchar' | 'bfrange' | undefined
  // The tokens of the entry being read
  let entry: CMapToken[] = []
  for (const token of tokens) {
    if (isWord(token, 'usecmap')) return undefined
    if (!section) {
      if (isWord(token, 'beginbfchar')) section = 'bfchar'
      else if (isWord(token, 'beginbfrange')) section = 'bfrange'
      continue
    }
    if (isWord(token, `end${section}`)) {
      if (entry.length > 0) return undefined
      section = undefined
      continue
    }
    entry.push(token)
    // The first three only, so a long array of values costs a step a value
    const [low, high, to] = [entry[0], entry[1], entry[2]].map(hexOf)
    if (low === undefined || (entry.length > 1 && high === undefined)) return undefined
    if (section === 'bfchar') {
      if (entry.length < 2) continue
      if (!add(utf16Units(high!))) return undefined
    } else if (entry.length < 3) {
      continue
    } else if (to !== undefined) {
      // Each code past the first maps to the next value of the last unit
      const first = utf16Units(to)
      const span = parseInt(high!, 16) - parseInt(low, 16)
      if (!(span >= 0) || first.length === 0) return undefined
      for (let i = 0; i <= span; i++) {
        if (!add([...first.slice(0, -1), first.at(-1)! + i])) return undefined
      }
    } else {
      // An array of values, a code each: `[`, hex strings, `]`
      const last = entry.at(-1)!
      if (!isWord(entry[2]!, '[')) return undefined
      if (entry.length === 3) continue
      if (!isWord(last, ']')) {
        if (hexOf(last) === undefined) return undefined
        continue
      }
      for (const each of entry.slice(3, -1)) if (!add(utf16Units(hexOf(each)!))) return undefined
    }
    entry = []
  }
  return section ? undefined : characters
}

/**
 * A ToUnicode value's bytes as UTF-16 code units, two each; one of an odd
 * number of bytes has a 0 before them, as pdf.js reads it: `<41>` is `A`.
 */
function utf16Units(hex: string): number[] {
  const units: number[] = []
  const even = (hex.length / 2) % 2 ? `00${hex}` : hex
  for (let i = 0; i < even.length; i += 4) units.push(parseInt(even.slice(i, i + 4), 16))
  return units
}

/** The family officeparser gives a run whose font pdf.js has no name for. */
const GENERIC_FAMILY = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/

/** Fonts whose codes are symbols, not the letters they would be in ASCII. */
const SYMBOL_FONT = /symbol|dingbat|wingding|webding/i

/**
 * Codes pdf.js moves to U+F000 and up for a font flagged as symbolic — which
 * a subset of an ordinary font can be: `<U+F039>` for `9`.
 */
const SYMBOLIC_CODES = /[\uF020-\uF07E]/g

/**
 * What a simple font's encoding can give for a code its ToUnicode leaves out:
 * Latin-1 past its controls, and the letters and signs beyond it that the
 * standard encodings (Standard, WinAnsi, MacRoman, PDFDoc) name — no more,
 * as a composite font of the same name gives its glyph numbers in Latin
 * Extended (`Ʒ` for `の`) — and a symbolic font's codes (U+F000 and up).
 */
const ENCODED =
  /[\u0020-\u00FF\u0131\u0141\u0142\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02C7\u02D8-\u02DD\u03A9\u03C0\u2013\u2014\u2018-\u201A\u201C-\u201E\u2020-\u2022\u2026\u2030\u2039\u203A\u2044\u20AC\u2122\u2202\u2206\u220F\u2211\u2212\u221A\u221E\u222B\u2248\u2260\u2264\u2265\u25CA\uF000-\uF0FF\uFB01\uFB02]/

/**
 * `page` with the characters its fonts cannot hold left out — all the text
 * of a font with glyph numbers and no ToUnicode, those a partial ToUnicode
 * does not give — and the codes of an ordinary font flagged as symbolic read
 * as the ASCII they are; with the characters left out and kept counted.
 * A run's font is named as officeparser names it, less the `+1` it adds to
 * tell two of a name apart (`runFont`), and which of the fonts of that name
 * drew it cannot be told: it keeps what any of them can hold. A run
 * officeparser names no font for — pdf.js has none for a font the file does
 * not embed, and officeparser then gives the generic family — may be in any
 * of the page's fonts.
 */
function readable(
  page: OfficeContentNode,
  fonts: PageFonts | undefined
): { page: OfficeContentNode | undefined; lost: number; kept: number } {
  let lost = 0
  let kept = 0
  // By the run's font name, and for a run with none, what any of the page's fonts holds
  const held = new Map<string | undefined, FontCharacters>()
  const holds = (font: string | undefined): FontCharacters => {
    if (!fonts) return null
    if (!held.has(font)) {
      const can =
        font === undefined
          ? [...fonts.byName.values()].reduce<FontCharacters | undefined>(eitherFont, fonts.anyName)
          : fonts.byName.has(font)
            ? eitherFont(fonts.anyName, fonts.byName.get(font)!)
            : null
      held.set(font, can ?? null)
    }
    return held.get(font)!
  }
  const visit = (node: OfficeContentNode): OfficeContentNode | undefined => {
    if (node.type === 'text') {
      const named = (node.formatting as { font?: string } | undefined)?.font
      const font = named && !GENERIC_FAMILY.test(named) ? runFont(named) : undefined
      let text = node.text ?? ''
      const can = holds(font)
      if (can) {
        const before = text.replace(/\s/g, '').length
        text = [...text]
          .filter((c) => can.mapped.has(c) || (can.encoded && ENCODED.test(c)) || /\s/.test(c))
          .join('')
        const after = text.replace(/\s/g, '').length
        lost += before - after
        kept += after
        // Gone with its text: left as white space, it would part the words around it
        if (after === 0 && before > 0) return undefined
      } else if (fonts) {
        kept += text.replace(/\s/g, '').length
      }
      if (font && !SYMBOL_FONT.test(font)) {
        text = text.replace(SYMBOLIC_CODES, (c) => String.fromCharCode(c.charCodeAt(0) - 0xf000))
      }
      return text === (node.text ?? '') ? node : { ...node, text }
    }
    if (!node.children?.length) return node
    const visited = node.children.map(visit)
    if (visited.every((child, i) => child === node.children![i])) return node
    const children = visited.filter((child) => child !== undefined)
    // Gone with its text: left without children, it would render a text of its own
    return children.length > 0 ? { ...node, children } : undefined
  }
  return { page: visit(page), lost, kept }
}

/** The anchors on a page, which an outline entry can point at instead of the page. */
function anchorsOn(page: OfficeContentNode): Set<string> {
  const anchors = new Set<string>()
  const walk = (node: OfficeContentNode) => {
    for (const id of (node.metadata as { anchorIds?: string[] } | undefined)?.anchorIds ?? []) {
      anchors.add(id)
    }
    node.children?.forEach(walk)
  }
  walk(page)
  return anchors
}

/**
 * A PDF's bookmarks as the headings over its pages: each page is under the
 * last bookmark that points at it or at a page before it.
 *
 * officeparser gives the outline as nested `list` items, each holding its
 * title in a node whose `link` is `#page=N`, or the anchor of a heading near
 * the top of that page, or `#internal` where it could not tell.
 */
class Bookmarks {
  private readonly entries: { path: string[]; page?: number; anchor?: string }[] = []
  private current: string[] | undefined

  constructor(outline: OfficeContentNode[] | undefined) {
    this.add(outline, [])
  }

  private add(items: OfficeContentNode[] | undefined, parent: string[]) {
    for (const item of items ?? []) {
      const target = item.children?.find((child) => child.type !== 'list' && linkOf(child))
      const title = target ? headingText(target) : ''
      const path = title ? [...parent, title] : parent
      const link = target ? linkOf(target)! : ''
      const page = /^#page=(\d+)$/.exec(link)
      if (title && page) this.entries.push({ path, page: Number(page[1]) })
      else if (title && link.startsWith('#') && link !== '#internal') {
        this.entries.push({ path, anchor: link.slice(1) })
      }
      this.add(
        item.children?.filter((child) => child.type === 'list'),
        path
      )
    }
  }

  /** The headings over `page`, read in page order. */
  at(page: number, anchors: Set<string>): string[] | undefined {
    for (const entry of this.entries) {
      if (entry.page === page || (entry.anchor !== undefined && anchors.has(entry.anchor))) {
        this.current = entry.path
      }
    }
    return this.current
  }
}

function linkOf(node: OfficeContentNode): string | undefined {
  const link = (node.metadata as { link?: unknown } | undefined)?.link
  return typeof link === 'string' ? link : undefined
}

const SHARED_STRINGS = 'xl/sharedStrings.xml'
const WORKBOOK = 'xl/workbook.xml'
const WORKBOOK_RELS = 'xl/_rels/workbook.xml.rels'
const SHEET = /^xl\/worksheets\/sheet(\d+)\.xml$/

/**
 * A sheet's rows a line each, their non-empty cells separated by tabs, as
 * blocks of consecutive rows (`sheetBlocks`), sheet after sheet in the
 * workbook's tab order. Only the shared strings are held whole — every cell
 * refers to them by index.
 */
async function* xlsxBlocks(filePath: string): AsyncGenerator<DocumentTextBlock> {
  const zip = await openZip(filePath)
  try {
    if (zip.entryCount > XLSX_MAX_ENTRIES) {
      throw new Error(`XLSX has ${zip.entryCount} entries, over ${XLSX_MAX_ENTRIES}`)
    }
    const entries = await listEntries(zip)
    const shared: string[] = []
    const strings = entries.get(SHARED_STRINGS)
    if (strings) {
      for await (const text of readPart(zip, strings, sharedStringParser)) {
        shared.push(oneLine(text))
      }
    }
    for (const [index, { part, name }] of (await sheetOrder(zip, entries)).entries()) {
      const entry = entries.get(part)
      if (!entry) continue
      yield* sheetBlocks(
        { sheet: index + 1, ...(name !== undefined && { sheetName: name }) },
        readPart<SheetRow>(zip, entry, (emit) => sheetRowParser(emit, shared))
      )
    }
  } finally {
    zip.close()
  }
}

/** An XLS workbook's rows, as an XLSX's are read. */
async function* xlsBlocks(filePath: string): AsyncGenerator<DocumentTextBlock> {
  for (const { sheet, name, rows } of xlsSheets(await readFile(filePath))) {
    yield* sheetBlocks({ sheet, ...(name && { sheetName: name }) }, xlsLines(rows))
  }
}

function* xlsLines(rows: Iterable<XlsRow>): Generator<SheetRow> {
  for (const { row, cells } of rows) yield { row, text: cells.map(oneLine).join('\t') }
}

/** A Word 97–2003 document's text, as a block: it marks no headings a reader of it can find. */
async function* docBlocks(filePath: string): AsyncGenerator<DocumentTextBlock> {
  yield { loc: {}, text: docText(await readFile(filePath)) }
}

/**
 * An Ichitaro document's text, a block per sheet where it has more than one,
 * as a workbook's are: what marks its headings is not yet read (ADR-051). A
 * sheet's name is not read either, so it goes by its number.
 */
async function* jtdBlocks(filePath: string): AsyncGenerator<DocumentTextBlock> {
  const sheets = jtdSheets(await readFile(filePath))
  if (sheets.length === 1) {
    yield { loc: {}, text: sheets[0]! }
    return
  }
  for (const [index, text] of sheets.entries()) {
    if (text) yield { loc: { sheet: index + 1 }, text }
  }
}

/** A PowerPoint 97–2003 presentation a slide at a time, under its title. */
async function* pptBlocks(filePath: string): AsyncGenerator<DocumentTextBlock> {
  for (const [index, { title, text }] of pptSlides(await readFile(filePath)).entries()) {
    const heading = oneHeading(title ?? '')
    yield { loc: { slide: index + 1 }, ...headingsOf(heading ? [heading] : undefined), text }
  }
}

/**
 * A sheet's rows as blocks of consecutive rows up to BLOCK_MAX_CHARS. Each
 * block says which row of its sheet each of its lines is: empty rows are not
 * in it, so the first row and a count would not.
 */
async function* sheetBlocks(
  sheet: DocumentTextLoc,
  lines: AsyncIterable<SheetRow> | Iterable<SheetRow>
): AsyncGenerator<DocumentTextBlock> {
  let rows: number[] = []
  let texts: string[] = []
  let length = 0
  const block = (): DocumentTextBlock => {
    const done = { loc: { ...sheet, rows }, text: texts.join('\n') }
    rows = []
    texts = []
    length = 0
    return done
  }
  for await (const { row, text } of lines) {
    // `length` counts a line break after each line, the last one's not in the text
    if (rows.length > 0 && length + text.length > BLOCK_MAX_CHARS) yield block()
    length += text.length + 1
    rows.push(row)
    texts.push(text)
  }
  if (rows.length > 0) yield block()
}

/**
 * The sheets' parts and names in the workbook's tab order, which need not
 * follow their file names; by the number in the name, and unnamed, where the
 * workbook does not say — the part's name (`sheet2`) would read as the
 * sheet's own.
 */
async function sheetOrder(
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

/**
 * A cell's text with its line breaks and tabs as spaces: a row is one line,
 * and its cells are told apart by tabs.
 */
function oneLine(text: string): string {
  return text.replace(/[\t\n\r]+/g, ' ')
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

interface SheetRow {
  row: number
  text: string
}

/**
 * Each `<row>` as its cells' values, shared strings looked up, and its number:
 * the sheet's own (`r`), or one past the last where a writer left it out.
 */
function sheetRowParser(emit: (row: SheetRow) => void, shared: string[]): PartParser {
  let row = 0
  let cells: string[] = []
  let type: string | undefined
  let value = ''
  let inValue = false
  let phonetic = 0
  return {
    open(tag: SaxesTagPlain) {
      if (tag.name === 'row') {
        const r = Number(tag.attributes.r)
        row = Number.isInteger(r) && r > 0 ? r : row + 1
      } else if (tag.name === 'c') {
        type = tag.attributes.t
        value = ''
      } else if (tag.name === 'rPh') phonetic++
      else if (tag.name === 'v' || tag.name === 't') inValue = true
    },
    close(tag: SaxesTagPlain) {
      if (tag.name === 'v' || tag.name === 't') inValue = false
      else if (tag.name === 'rPh') phonetic--
      else if (tag.name === 'c') {
        const text = type === 's' ? (shared[Number(value)] ?? '') : oneLine(value)
        // Formatted but empty: officeparser leaves such cells out, and rows of them
        if (text) cells.push(text)
      } else if (tag.name === 'row') {
        if (cells.length > 0) emit({ row, text: cells.join('\t') })
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
