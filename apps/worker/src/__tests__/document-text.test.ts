import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { OfficeParser, type OfficeContentNode, type OfficeParserConfig } from 'officeparser'
import { PDFDocument, PDFName, drawObject } from 'pdf-lib'
import JSZip from 'jszip'
import { DOCUMENT_TEXT_SCHEMA, type DocumentTextBlock } from '@kukan/shared'
import { artifactBlocks } from './test-helpers/document-text'
import { documentBlocks, extractDocumentText } from '../pipeline/steps/document-text'
import { PDF_RANGE_BYTES, PDF_RANGE_MAX_PAGES } from '@/config'
import { xlsxBuffer } from './test-helpers/xlsx'

vi.mock('@/config', async (original) => ({
  ...(await original<typeof import('@/config')>()),
  XLSX_MAX_PART_BYTES: 1024 * 1024,
  XLSX_MAX_ENTRIES: 10,
}))

vi.mock('officeparser', () => ({ OfficeParser: { parseOffice: vi.fn() } }))
const parseOffice = vi.mocked(OfficeParser.parseOffice)
/** The page range a call asked for; the second argument can also be a callback */
const rangeOf = (config: unknown) =>
  (config as OfficeParserConfig | undefined)?.pdfParserConfig?.pageRange

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'document-text-'))
  parseOffice.mockReset()
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function file(name: string, content: Buffer): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, content)
  return path
}

async function blocks(path: string, format: string): Promise<DocumentTextBlock[]> {
  const out: DocumentTextBlock[] = []
  for await (const block of documentBlocks(path, format)) out.push(block)
  return out
}

async function lines(path: string, format: string): Promise<string[]> {
  return (await blocks(path, format)).map((block) => block.text)
}

/** A node officeparser would give, its text what it renders as. */
function node(
  type: OfficeContentNode['type'],
  text: string,
  metadata?: object,
  children?: OfficeContentNode[]
): OfficeContentNode {
  return { type, text, metadata, children } as OfficeContentNode
}

/** A PDF page as officeparser gives it, with the anchors of what is on it. */
function page(pageNumber: number, text: string, extra: object = {}, anchorIds?: string[]) {
  return node('page', text, { pageNumber, ...extra }, [node('paragraph', text, { anchorIds })])
}

/**
 * An AST that renders whatever part of it is asked for, a line per top-level
 * node, the way officeparser does: a picture as `[Image: description]` unless
 * asked for none.
 */
function astOf(content: OfficeContentNode[], extra: object = {}) {
  const text = (n: OfficeContentNode, images: boolean): string => {
    if (n.type === 'image') {
      return images ? `[Image: ${(n.metadata as { altText?: string }).altText}]` : ''
    }
    if (!n.children?.length) return n.text ?? ''
    return n.children
      .map((c) => text(c, images))
      .filter(Boolean)
      .join('\n')
  }
  return {
    content,
    ...extra,
    async to(this: { content: OfficeContentNode[] }, _format: string, options?: object) {
      const images = (options as { includeImages?: string } | undefined)?.includeImages !== 'none'
      return { value: this.content.map((n) => text(n, images)).join('\n') }
    },
  } as never
}

describe('XLSX', () => {
  it('reads the sheets in their numbered order, a row per line', async () => {
    const path = await file(
      'a.xlsx',
      await xlsxBuffer({ sheets: { 10: [[10]], 2: [[2]], 1: [[1, 1.5]] } })
    )
    expect(await lines(path, 'xlsx')).toEqual(['1\t1.5', '2', '10'])
  })

  it('reads the sheets in the order of the workbook tabs', async () => {
    const path = await file(
      'tabs.xlsx',
      await xlsxBuffer({ sheets: { 1: [[1]], 2: [[2]], 3: [[3]] }, tabs: [3, 1, 2] })
    )
    expect(await lines(path, 'xlsx')).toEqual(['3', '1', '2'])
  })

  it('says which sheet and row each block is', async () => {
    const path = await file(
      'where.xlsx',
      await xlsxBuffer({ sheets: { 1: [[1], [], [3]], 2: [[4]] }, tabs: [2, 1] })
    )
    expect((await blocks(path, 'xlsx')).map((b) => b.loc)).toEqual([
      { sheet: 's2', row: 1 },
      { sheet: 's1', row: 1 },
      { sheet: 's1', row: 3 },
    ])
  })

  it.each(['./worksheets/', '../xl/worksheets/'])(
    'finds the sheets through a relationship written as %s',
    async (target) => {
      const path = await file(
        'relative.xlsx',
        await xlsxBuffer({ sheets: { 1: [[1, 2]] }, tabs: [1], target })
      )
      expect(await lines(path, 'xlsx')).toEqual(['1\t2'])
    }
  )

  it('leaves out empty cells, and rows with none but those', async () => {
    const path = await file(
      'gaps.xlsx',
      await xlsxBuffer({ sheets: { 1: [[1, 2], [], [3, { empty: true }, 4], [{ empty: true }]] } })
    )
    expect(await lines(path, 'xlsx')).toEqual(['1\t2', '3\t4'])
  })

  it('refuses an archive with more entries than the limit', async () => {
    const sheets = Object.fromEntries(Array.from({ length: 12 }, (_, n) => [n + 1, [[n]]]))
    const path = await file('many.xlsx', await xlsxBuffer({ sheets }))
    await expect(lines(path, 'xlsx')).rejects.toThrow(/\d+ entries, over 10/)
  })

  it('joins a rich string, and leaves its phonetic reading out', async () => {
    const path = await file(
      'b.xlsx',
      await xlsxBuffer({
        shared: [
          '<si><r><t>東京</t></r><r><t>都</t></r><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si>',
        ],
        sheets: { 1: [[{ s: 0 }]] },
      })
    )
    expect(await lines(path, 'xlsx')).toEqual(['東京都'])
  })

  it('keeps characters whole across the chunks a large sheet arrives in', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => [{ inline: `行${i}：日本語のテキスト` }])
    const path = await file('c.xlsx', await xlsxBuffer({ sheets: { 1: rows } }))

    const out = await lines(path, 'xlsx')
    expect(out).toHaveLength(5000)
    expect(out[4999]).toBe('行4999：日本語のテキスト')
    expect(out.join('')).not.toContain('�')
  })

  it('refuses a part larger uncompressed than the limit', async () => {
    const rows = Array.from({ length: 50_000 }, (_, i) => [i])
    const path = await file('d.xlsx', await xlsxBuffer({ sheets: { 1: rows } }))
    await expect(lines(path, 'xlsx')).rejects.toThrow(/sheet1\.xml is \d+ bytes uncompressed/)
  })
})

describe('PDF', () => {
  /**
   * officeparser as it answers a page range: this range's text (by default
   * naming the range), the whole page count.
   */
  function pdfOf(pages: number, textOf = (range: string) => `pages ${range}`) {
    parseOffice.mockImplementation(async (_path, config) => {
      const range = rangeOf(config)!
      return {
        metadata: { pages },
        to: async () => ({ value: textOf(range) }),
      } as never
    })
  }

  const ranges = () => parseOffice.mock.calls.map(([, config]) => rangeOf(config))

  it('reads a few pages first, then ranges sized by the bytes per page', async () => {
    pdfOf(12)
    // A megabyte a page, heavy with images: the smallest ranges
    const path = await file('heavy.pdf', Buffer.alloc(12 * 1024 * 1024))

    expect(await lines(path, 'pdf')).toEqual(['pages 1-3', 'pages 4-6', 'pages 7-9', 'pages 10-12'])
    expect(ranges()).toEqual(['1-3', '4-6', '7-9', '10-12'])
  })

  it('leaves out ranges with no text', async () => {
    const texts: Record<string, string> = { '1-3': '', '4-6': 'B', '7-9': '', '10-12': 'D' }
    pdfOf(12, (range) => texts[range])
    const path = await file('gaps.pdf', Buffer.alloc(12 * 1024 * 1024))

    expect(await lines(path, 'pdf')).toEqual(['B', 'D'])
  })

  it('reads light pages many at a time, up to the most a range holds', async () => {
    const pages = PDF_RANGE_MAX_PAGES + 100
    pdfOf(pages)
    const path = await file('light.pdf', Buffer.alloc(Math.floor(PDF_RANGE_BYTES / 1000)))

    await lines(path, 'pdf')
    expect(ranges()).toEqual([
      '1-3',
      `4-${3 + PDF_RANGE_MAX_PAGES}`,
      `${4 + PDF_RANGE_MAX_PAGES}-${pages}`,
    ])
  })

  it('reads the whole document at once when the page count does not come back', async () => {
    parseOffice.mockResolvedValue({
      metadata: {},
      to: async () => ({ value: 'all\nof it' }),
    } as never)
    const path = await file('odd.pdf', Buffer.alloc(10))

    expect(await lines(path, 'pdf')).toEqual(['all\nof it'])
    expect(ranges()).toEqual(['1-3', undefined])
  })

  it('reads a block per page, saying which page and where it is printed otherwise', async () => {
    parseOffice.mockResolvedValue(
      astOf([page(1, 'cover', { pageLabel: 'i' }), page(2, ''), page(3, 'body')], {
        metadata: { pages: 3 },
      })
    )
    const path = await file('pages.pdf', Buffer.alloc(10))

    expect(await blocks(path, 'pdf')).toEqual([
      { loc: { page: 1, label: 'i' }, text: 'cover' },
      // Kept, so a page with nothing to read is on record as one
      { loc: { page: 2 }, text: '', textLayer: false },
      { loc: { page: 3 }, text: 'body' },
    ])
  })

  /** A bookmark: its title in a node linking to its destination, then its children. */
  const bookmark = (title: string, link: string, children: OfficeContentNode[] = []) =>
    node('list', title, {}, [node('text', title, { link }), ...children])

  it('puts each page under the last bookmark at or before it, in every range', async () => {
    const outline = [
      bookmark('第1章', '#page=1', [bookmark('1.1 目的', '#page=2')]),
      bookmark('第2章', '#chapter-2'),
      bookmark('索引', '#internal'),
    ]
    parseOffice.mockImplementation(async (_path, config) => {
      const pages =
        rangeOf(config) === '1-3'
          ? [page(1, 'a'), page(2, 'b'), page(3, 'c')]
          : [page(4, 'd', {}, ['chapter-2']), page(5, 'e')]
      return astOf(pages, { metadata: { pages: 5 }, auxiliary: { outline } })
    })
    const path = await file('outline.pdf', Buffer.alloc(5 * 1024 * 1024))

    expect((await blocks(path, 'pdf')).map((b) => [b.loc.page, b.headings])).toEqual([
      [1, ['第1章']],
      [2, ['第1章', '1.1 目的']],
      [3, ['第1章', '1.1 目的']],
      // The bookmark points at a heading's anchor rather than at the page
      [4, ['第2章']],
      [5, ['第2章']],
    ])
  })

  /** An image XObject, its bytes standing in for a picture called `name`. */
  function imageStream(doc: PDFDocument, name: string, width: number, height: number) {
    return doc.context.register(
      doc.context.stream(Buffer.from(`bytes of ${name}`), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: width,
        Height: height,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
      })
    )
  }

  /**
   * A PDF whose pages draw the given images, each `[name, width, height]`;
   * images of one name are one picture stored again, as a page decoration is.
   */
  async function pdfWithImages(pages: [string, number, number][][]): Promise<Buffer> {
    const doc = await PDFDocument.create()
    for (const images of pages) {
      const page = doc.addPage()
      for (const [i, [name, width, height]] of images.entries()) {
        page.node.setXObject(PDFName.of(`Im${i}`), imageStream(doc, name, width, height))
        page.pushOperators(drawObject(`Im${i}`))
      }
    }
    return Buffer.from(await doc.save({ useObjectStreams: false }))
  }

  it('lists the images on each page after its text, the ones too small for a figure left out', async () => {
    parseOffice.mockResolvedValue(
      astOf([page(1, 'one'), page(2, 'two')], { metadata: { pages: 2 } })
    )
    const path = await file(
      'figures.pdf',
      await pdfWithImages([
        [
          ['map', 900, 800],
          ['icon', 16, 16],
        ],
        [['map', 900, 800]],
      ])
    )

    const out = await blocks(path, 'pdf')

    expect(out.map((b) => [b.loc.page, b.text, b.figure?.width, b.figure?.height])).toEqual([
      [1, 'one', undefined, undefined],
      [1, '', 900, 800],
      [2, 'two', undefined, undefined],
      [2, '', 900, 800],
    ])
    const [first, second] = out.filter((b) => b.figure).map((b) => b.figure!)
    // Two objects holding one picture: the digest says so, the reference does not
    expect(first.ref).toMatch(/^\d+ 0 R$/)
    expect(first.ref).not.toBe(second.ref)
    expect(first.digest).toBe(second.digest)
  })

  it('reads the text of a PDF whose page tree its images are listed from is broken', async () => {
    parseOffice.mockResolvedValue(astOf([page(1, 'text')], { metadata: { pages: 1 } }))
    const doc = await PDFDocument.create()
    doc.addPage()
    // A page tree officeparser reads leniently and pdf-lib refuses
    doc.catalog.set(PDFName.of('Pages'), doc.context.obj(1))
    const path = await file('broken-tree.pdf', Buffer.from(await doc.save()))

    expect(await blocks(path, 'pdf')).toEqual([{ loc: { page: 1 }, text: 'text' }])
  })

  it('lists only the images a page draws, not every one its resources name', async () => {
    parseOffice.mockResolvedValue(
      astOf([page(1, 'map'), page(2, 'text only')], { metadata: { pages: 2 } })
    )
    const doc = await PDFDocument.create()
    const first = doc.addPage()
    const second = doc.addPage()
    first.node.setXObject(PDFName.of('Map'), imageStream(doc, 'map', 900, 800))
    first.pushOperators(drawObject('Map'))
    // One resource dictionary for both pages, as writers share it
    second.node.set(PDFName.of('Resources'), first.node.get(PDFName.of('Resources'))!)
    second.drawText('text only')
    const path = await file('shared.pdf', Buffer.from(await doc.save()))

    const figures = (await blocks(path, 'pdf')).filter((b) => b.figure)

    expect(figures.map((b) => b.loc.page)).toEqual([1])
  })

  it('reads the text of a PDF its images cannot be listed from', async () => {
    parseOffice.mockResolvedValue(astOf([page(1, 'text')], { metadata: { pages: 1 } }))
    const path = await file('not-really.pdf', Buffer.from('not a pdf'))

    expect(await blocks(path, 'pdf')).toEqual([{ loc: { page: 1 }, text: 'text' }])
  })

  it('gives no headings for a PDF without bookmarks, whatever its text looks like', async () => {
    parseOffice.mockResolvedValue(
      astOf([node('page', '２', { pageNumber: 1 }, [node('heading', '２', { level: 3 })])], {
        metadata: { pages: 1 },
      })
    )
    const path = await file('flat.pdf', Buffer.alloc(10))

    expect(await blocks(path, 'pdf')).toEqual([{ loc: { page: 1 }, text: '２' }])
  })
})

describe('Office documents', () => {
  it('reads a document in runs from one heading to the next, under their path', async () => {
    parseOffice.mockResolvedValue(
      astOf([
        node('paragraph', 'preface'),
        node('heading', '第1章　総則', { level: 1 }),
        node('paragraph', 'one'),
        node('heading', '1.1  目的', { level: 2 }),
        node('paragraph', 'purpose'),
        node('heading', '第2章', { level: 1 }),
        node('paragraph', 'two'),
      ])
    )
    const path = await file('a.docx', Buffer.alloc(10))

    expect(await blocks(path, 'docx')).toEqual([
      { loc: {}, text: 'preface' },
      { loc: {}, headings: ['第1章 総則'], text: '第1章　総則\none' },
      { loc: {}, headings: ['第1章 総則', '1.1 目的'], text: '1.1  目的\npurpose' },
      { loc: {}, headings: ['第2章'], text: '第2章\ntwo' },
    ])
  })

  it('follows a run with its pictures, the run rendered without them', async () => {
    parseOffice.mockResolvedValue(
      astOf([
        node('heading', '第1章', { level: 1 }),
        node('paragraph', '', {}, [
          node('text', 'before'),
          node('image', '', { attachmentName: 'word/media/image1.png', altText: '位置図' }),
        ]),
      ])
    )
    const path = await file('figure.docx', Buffer.alloc(10))

    expect(await blocks(path, 'docx')).toEqual([
      { loc: {}, headings: ['第1章'], text: '第1章\nbefore' },
      {
        loc: {},
        headings: ['第1章'],
        text: '位置図',
        figure: { ref: 'word/media/image1.png' },
      },
    ])
  })

  it('reads a presentation a slide at a time, under its title', async () => {
    parseOffice.mockResolvedValue(
      astOf([
        node('slide', 'Plan\nbody', { slideNumber: 1 }, [
          node('heading', 'Plan', { level: 1 }),
          node('paragraph', 'body'),
        ]),
        node('slide', 'untitled', { slideNumber: 2 }, [
          node('paragraph', 'untitled'),
          // officeparser names a picture by its file name alone
          node('image', '', { attachmentName: 'image3.png', altText: ' 市域の地図 ' }),
        ]),
      ])
    )
    // The picture's part is looked up in the package by its file name
    const pptx = new JSZip()
    pptx.file('ppt/media/image3.png', 'png')
    const path = await file('a.pptx', await pptx.generateAsync({ type: 'nodebuffer' }))

    expect(await blocks(path, 'pptx')).toEqual([
      { loc: { slide: 1 }, headings: ['Plan'], text: 'Plan\nbody' },
      { loc: { slide: 2 }, text: 'untitled' },
      // Its author's description is its text
      { loc: { slide: 2 }, text: '市域の地図', figure: { ref: 'ppt/media/image3.png' } },
    ])
  })
})

describe('the artifact', () => {
  it('splits a line longer than a block between characters, not inside one', async () => {
    // 😀 is two UTF-16 code units: cut between them, both halves read as �
    const text = 'x'.repeat(31_999) + '😀end'
    parseOffice.mockResolvedValue(astOf([node('paragraph', text)]))
    const path = await file('emoji.docx', Buffer.alloc(10))
    const artifact = join(dir, 'text.ndjson.zst')

    await extractDocumentText(path, 'docx', artifact)

    const texts = (await artifactBlocks(await readFile(artifact))).map((b) => b.text)
    expect(texts.join('')).toBe(text)
    // Each block whole on its own: the index joins them with newlines
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    expect(texts.filter((t) => loneSurrogate.test(t))).toEqual([])
  })

  it('writes a long run of text as blocks a line at most so long, split between lines', async () => {
    const line = 'あ'.repeat(10_000)
    parseOffice.mockResolvedValue(astOf([node('paragraph', Array(7).fill(line).join('\n'))]))
    const path = await file('long.docx', Buffer.alloc(10))
    const artifact = join(dir, 'text.ndjson.zst')

    const extracted = await extractDocumentText(path, 'docx', artifact)

    const texts = (await artifactBlocks(await readFile(artifact))).map((b) => b.text)
    expect(texts.map((t) => t.length)).toEqual([30_002, 30_002, 10_000])
    expect(texts.join('\n')).toBe(Array(7).fill(line).join('\n'))
    // Counted as the text it was, not as the blocks it was written in
    expect(extracted.bytes).toBe(Buffer.byteLength(Array(7).fill(line).join('\n')))
  })

  it('writes a header, then a block per line, through zstd', async () => {
    parseOffice.mockResolvedValue(
      astOf([node('heading', 'Title', { level: 1 }), node('paragraph', 'body')])
    )
    const path = await file('a.docx', Buffer.alloc(10))
    const artifact = join(dir, 'text.ndjson.zst')

    const extracted = await extractDocumentText(path, 'docx', artifact)

    const written = zstdDecompressSync(await readFile(artifact)).toString('utf-8')
    expect(
      written
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual([
      { schema: DOCUMENT_TEXT_SCHEMA },
      { loc: {}, headings: ['Title'], text: 'Title\nbody' },
    ])
    expect(extracted).toEqual({ hasText: true, bytes: Buffer.byteLength('Title\nbody') })
  })

  it('says there is no text when every block is blank', async () => {
    parseOffice.mockResolvedValue(astOf([page(1, ' '), page(2, '')], { metadata: { pages: 2 } }))
    const path = await file('scan.pdf', Buffer.alloc(10))

    expect(await extractDocumentText(path, 'pdf', join(dir, 'out.zst'))).toEqual({
      hasText: false,
      bytes: 1,
    })
  })
})
