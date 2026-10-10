import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { OfficeParser, type OfficeContentNode, type OfficeParserConfig } from 'officeparser'
import {
  PDFDocument,
  PDFName,
  PDFString,
  beginText,
  drawObject,
  endText,
  setFontAndSize,
} from '@cantoo/pdf-lib'
import JSZip from 'jszip'
import { DOCUMENT_TEXT_SCHEMA, type DocumentTextBlock } from '@kukan/shared'
import { artifactBlocks } from '../../../test-helpers/document-text'
import { documentBlocks, extractDocumentText } from '@/pipeline/interpret/document/document-text'
import { PDF_RANGE_BYTES, PDF_RANGE_MAX_PAGES } from '@/config'
import { xlsxBuffer } from '../../../test-helpers/xlsx'
import {
  biff,
  bof,
  cell,
  chartSubstream,
  EOF_RECORD,
  jtd,
  cutShort,
  jtdBuffer,
  sharingSectors,
  jtdStream,
  docBuffer,
  ppt,
  pptBuffer,
  pptDocument,
  rkDouble,
  rkInt,
  sstData,
  xlsBuffer,
} from '../../../test-helpers/legacy-office'

vi.mock('@/config', async (original) => ({
  ...(await original<typeof import('@/config')>()),
  XLSX_MAX_PART_BYTES: 1024 * 1024,
  XLSX_MAX_ENTRIES: 10,
  DOCUMENT_TEXT_MAX_BYTES: 4 * 1024 * 1024,
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

/** A PDF page of top-level nodes, as officeparser gives a tagged one. */
const tagged = (pageNumber: number, nodes: OfficeContentNode[]) =>
  node('page', '', { pageNumber }, nodes)
/** A heading, its text its runs' where it is given them. */
const h = (level: number, text: string, runs?: OfficeContentNode[]) =>
  node('heading', text, { level }, runs)
const p = (text: string) => node('paragraph', text)

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
  /** Each line of each block: a row of a sheet. */
  async function rows(path: string): Promise<string[]> {
    return (await lines(path, 'xlsx')).flatMap((text) => text.split('\n'))
  }

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

  it("runs a sheet's rows into a block, saying which sheet and which row each line is", async () => {
    const path = await file(
      'where.xlsx',
      await xlsxBuffer({ sheets: { 1: [[1], [], [3]], 2: [[4]] }, tabs: [2, 1] })
    )
    expect(await blocks(path, 'xlsx')).toEqual([
      { loc: { sheet: 1, sheetName: 's2', rows: [1] }, text: '4' },
      // The empty row is in neither the text nor the numbers
      { loc: { sheet: 2, sheetName: 's1', rows: [1, 3] }, text: '1\n3' },
    ])
  })

  it('numbers a sheet the workbook does not name, and makes up no name for it', async () => {
    const path = await file('unnamed.xlsx', await xlsxBuffer({ sheets: { 1: [[1]], 2: [[2]] } }))

    expect((await blocks(path, 'xlsx')).map((b) => b.loc)).toEqual([
      { sheet: 1, rows: [1] },
      { sheet: 2, rows: [1] },
    ])
  })

  it('starts another block where the next row would take it past its size', async () => {
    const long = 'あ'.repeat(20_000)
    const path = await file(
      'long.xlsx',
      await xlsxBuffer({ sheets: { 1: [[{ inline: long }], [{ inline: long }], [1]] } })
    )

    expect((await blocks(path, 'xlsx')).map((b) => b.loc.rows)).toEqual([[1], [2, 3]])
  })

  it('reads a line break or a tab in a cell as a space, a row staying one line', async () => {
    const path = await file(
      'breaks.xlsx',
      await xlsxBuffer({ sheets: { 1: [[{ inline: '東京\n都' }, { inline: 'a\tb' }], [2]] } })
    )

    expect(await blocks(path, 'xlsx')).toEqual([
      { loc: { sheet: 1, rows: [1, 2] }, text: '東京 都\ta b\n2' },
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
    expect(await rows(path)).toEqual(['1\t2', '3\t4'])
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
    const sheet = Array.from({ length: 5000 }, (_, i) => [{ inline: `行${i}：日本語のテキスト` }])
    const path = await file('c.xlsx', await xlsxBuffer({ sheets: { 1: sheet } }))

    const out = await rows(path)
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

  it('reads on when a later range does not say the page count', async () => {
    parseOffice.mockImplementation(async (_path, config) => {
      const range = rangeOf(config)
      return {
        metadata: range === '1-3' ? { pages: 6 } : {},
        to: async () => ({ value: `pages ${range}` }),
      } as never
    })
    const path = await file('later.pdf', Buffer.alloc(6 * 1024 * 1024))

    expect(await lines(path, 'pdf')).toEqual(['pages 1-3', 'pages 4-6'])
    expect(ranges()).toEqual(['1-3', '4-6'])
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
      { loc: { page: 2 }, text: '', unreadable: 'no-text' },
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

  it('puts the images of a page split at its tagged headings under those it ends under', async () => {
    parseOffice.mockResolvedValue(
      astOf([tagged(1, [h(1, 'A'), h(1, 'B')])], { metadata: { pages: 1 } })
    )
    const path = await file('split-figures.pdf', await pdfWithImages([[['map', 900, 800]]]))

    expect((await blocks(path, 'pdf')).map((b) => [b.text, b.headings, !!b.figure])).toEqual([
      ['A', ['A'], false],
      ['B', ['B'], false],
      ['', ['B'], true],
    ])
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

  /** A run of text in a font, as officeparser names it. */
  const run = (text: string, font: string) =>
    ({ type: 'text', text, formatting: { font } }) as OfficeContentNode

  /** A PDF page made of runs, a paragraph each. */
  const pageOfRuns = (pageNumber: number, runs: OfficeContentNode[]) =>
    node(
      'page',
      '',
      { pageNumber },
      runs.map((r) => node('paragraph', r.text!, {}, [r]))
    )

  /**
   * A font, `[name, kind, fontName, { toUnicode, embedded }]`: its BaseFont —
   * a composite font's, its descendant's — and a composite font with an
   * Identity-H encoding, numbering its glyphs itself or as Adobe-Japan1, or
   * one with a CMap of Unicode (`unicode`), or a simple TrueType font; the
   * FontName of a descriptor, where it has one; the body of a ToUnicode CMap,
   * where it has one; and whether the file embeds it.
   */
  type FontSpec = [
    string,
    'identity' | 'japan1' | 'unicode' | 'simple',
    string?,
    { toUnicode?: string; embedded?: boolean }?,
  ]

  /** A font's dictionary: a composite one named by its descendant, as writers do. */
  function fontOf(
    doc: PDFDocument,
    [name, kind, fontName, { toUnicode, embedded } = {}]: FontSpec
  ) {
    const cmap =
      toUnicode &&
      doc.context.register(
        doc.context.stream(
          `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n` +
            `1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${toUnicode}\n` +
            `endcmap\nend\nend`
        )
      )
    const descriptor = (fontName || embedded) && {
      Type: 'FontDescriptor',
      ...(fontName && { FontName: `ABCDEF+${fontName}` }),
      ...(embedded && { FontFile2: doc.context.register(doc.context.stream('')) }),
    }
    const font =
      kind === 'simple'
        ? {
            Type: 'Font',
            Subtype: 'TrueType',
            BaseFont: name,
            Encoding: 'WinAnsiEncoding',
            ...(cmap && { ToUnicode: cmap }),
          }
        : {
            Type: 'Font',
            Subtype: 'Type0',
            BaseFont: `${name}-${kind === 'unicode' ? 'UniJIS-UCS2-H' : 'Identity-H'}`,
            Encoding: kind === 'unicode' ? 'UniJIS-UCS2-H' : 'Identity-H',
            ...(cmap && { ToUnicode: cmap }),
            DescendantFonts: [
              {
                Type: 'Font',
                Subtype: 'CIDFontType0',
                BaseFont: `ABCDEF+${name}`,
                ...(descriptor && { FontDescriptor: descriptor }),
                CIDSystemInfo: {
                  Registry: PDFString.of('Adobe'),
                  Ordering: PDFString.of(kind === 'identity' ? 'Identity' : 'Japan1'),
                  Supplement: 0,
                },
              },
            ],
          }
    return doc.context.register(doc.context.obj(font))
  }

  /** Content setting text in each of `count` fonts, named `prefix` and its index. */
  const settingText = (prefix: string, count: number) =>
    [...Array(count).keys()].flatMap((i) => [
      beginText(),
      setFontAndSize(`${prefix}${i}`, 12),
      endText(),
    ])

  /**
   * A PDF whose pages each set text in the given fonts; each also naming the
   * `named` fonts without using them, and drawing a form that sets text in the
   * `form` ones; encrypted for anyone to open, where asked.
   */
  async function pdfWithFonts(
    pages: FontSpec[][],
    {
      named = [],
      form,
      encrypted,
    }: { named?: FontSpec[]; form?: FontSpec[]; encrypted?: boolean } = {}
  ): Promise<Buffer> {
    const doc = await PDFDocument.create()
    for (const fonts of pages) {
      const page = doc.addPage()
      fonts.forEach((font, i) =>
        page.node.setFontDictionary(PDFName.of(`F${i}`), fontOf(doc, font))
      )
      named.forEach((font, i) =>
        page.node.setFontDictionary(PDFName.of(`N${i}`), fontOf(doc, font))
      )
      page.pushOperators(...settingText('F', fonts.length))
      if (form) {
        const xobject = doc.context.formXObject(settingText('G', form.length), {
          BBox: [0, 0, 10, 10],
          Resources: {
            Font: Object.fromEntries(form.map((font, i) => [`G${i}`, fontOf(doc, font)])),
          },
        })
        page.node.setXObject(PDFName.of('Fm0'), doc.context.register(xobject))
        page.pushOperators(drawObject('Fm0'))
      }
    }
    if (!encrypted) return Buffer.from(await doc.save({ useObjectStreams: false }))
    // Opened by anyone, its text not to be copied: encrypted under an empty
    // user password, its dictionaries in object streams as writers put them,
    // where unless decrypted they cannot be read
    doc.encrypt({ userPassword: '', ownerPassword: 'owner', permissions: { copying: false } })
    return Buffer.from(await doc.save({ useObjectStreams: true }))
  }

  it('leaves out text in a font with no map to characters, and marks a page mostly in one', async () => {
    parseOffice.mockResolvedValue(
      astOf(
        [
          pageOfRuns(1, [run('ࡢࡀ㈤㔠ㄪᰝ', 'MS-Mincho'), run('10', 'Century')]),
          pageOfRuns(2, [run('ࡢ', 'MS-Mincho'), run('Annual report', 'Century')]),
        ],
        { metadata: { pages: 2 } }
      )
    )
    const fonts: FontSpec[] = [
      ['MS-Mincho', 'identity'],
      ['Century', 'simple'],
    ]
    const path = await file('unmapped.pdf', await pdfWithFonts([fonts, fonts]))

    expect(await blocks(path, 'pdf')).toEqual([
      { loc: { page: 1 }, text: '10', unreadable: 'unmapped-fonts', unmappedChars: 6 },
      { loc: { page: 2 }, text: 'Annual report', unmappedChars: 1 },
    ])
  })

  it('marks each block of a page split at its tagged headings, and titles them without what is left out', async () => {
    parseOffice.mockResolvedValue(
      astOf(
        [
          tagged(1, [
            node('paragraph', '', {}, [run('ࡢࡀ㈤㔠ㄪᰝ', 'MS-Mincho')]),
            h(1, 'Summaryࡢࡀ', [run('Summary', 'Century'), run('ࡢࡀ', 'MS-Mincho')]),
            h(1, 'Detail', [run('Detail', 'Century')]),
          ]),
        ],
        { metadata: { pages: 1 } }
      )
    )
    const fonts: FontSpec[] = [
      ['MS-Mincho', 'identity'],
      ['Century', 'simple'],
    ]
    const path = await file('split-marks.pdf', await pdfWithFonts([fonts]))

    expect(await blocks(path, 'pdf')).toEqual([
      // The run before the first heading lost all its text, and is left out
      { loc: { page: 1 }, headings: ['Summary'], text: 'Summary', unmappedChars: 8 },
      { loc: { page: 1 }, headings: ['Detail'], text: 'Detail', unmappedChars: 8 },
    ])
  })

  it('leaves out a run with no font named only where every font the page sets text in is unmapped', async () => {
    const unnamed = { type: 'text', text: 'ࡢࡀ', formatting: {} } as OfficeContentNode
    parseOffice.mockResolvedValue(
      astOf(
        [
          pageOfRuns(1, [unnamed]),
          // The generic family officeparser falls back to is no name either
          pageOfRuns(2, [run('ࡢࡀ', 'serif')]),
          pageOfRuns(3, [{ ...unnamed, text: '本文' }]),
        ],
        { metadata: { pages: 3 } }
      )
    )
    const path = await file(
      'unnamed.pdf',
      await pdfWithFonts([
        [['MS-Mincho', 'identity']],
        [['MS-Mincho', 'identity']],
        [
          ['MS-Mincho', 'identity'],
          ['Century', 'simple'],
        ],
      ])
    )

    expect(await blocks(path, 'pdf')).toEqual([
      { loc: { page: 1 }, text: '', unreadable: 'unmapped-fonts', unmappedChars: 2 },
      { loc: { page: 2 }, text: '', unreadable: 'unmapped-fonts', unmappedChars: 2 },
      { loc: { page: 3 }, text: '本文' },
    ])
  })

  it('judges the fonts a form the page draws sets text in', async () => {
    parseOffice.mockResolvedValue(
      astOf([pageOfRuns(1, [run('ࡢࡀ', 'MS-Mincho')]), pageOfRuns(2, [run('本文', 'sans-serif')])], {
        metadata: { pages: 2 },
      })
    )
    const unmappedInForm = await file(
      'form-unmapped.pdf',
      await pdfWithFonts([[]], { form: [['MS-Mincho', 'identity']] })
    )
    const mappedInForm = await file(
      'form-mapped.pdf',
      await pdfWithFonts([[], [['MS-Mincho', 'identity']]], { form: [['Century', 'simple']] })
    )

    expect((await blocks(unmappedInForm, 'pdf'))[0]).toEqual({
      loc: { page: 1 },
      text: '',
      unreadable: 'unmapped-fonts',
      unmappedChars: 2,
    })
    // A run with no font named may be the form's, in a mapped font
    expect((await blocks(mappedInForm, 'pdf'))[1]).toEqual({ loc: { page: 2 }, text: '本文' })
  })

  it('judges only the fonts a page sets text in, not every one its resources name', async () => {
    parseOffice.mockResolvedValue(
      astOf([pageOfRuns(1, [run('ࡢࡀ', 'MS-Mincho')])], { metadata: { pages: 1 } })
    )
    const path = await file(
      'named-only.pdf',
      // Pages share one dictionary of every font in the document
      await pdfWithFonts([[['MS-Mincho', 'identity']]], { named: [['MS-Mincho', 'simple']] })
    )

    expect(await blocks(path, 'pdf')).toEqual([
      { loc: { page: 1 }, text: '', unreadable: 'unmapped-fonts', unmappedChars: 2 },
    ])
  })

  it('judges a form without resources of its own by the fonts of each page that draws it', async () => {
    const unnamed = (text: string) => ({ type: 'text', text, formatting: {} }) as OfficeContentNode
    parseOffice.mockResolvedValue(
      astOf([pageOfRuns(1, [unnamed('ࡢࡢ')]), pageOfRuns(2, [unnamed('AA')])], {
        metadata: { pages: 2 },
      })
    )
    // One form, setting text in /F0 of whichever page draws it
    const doc = await PDFDocument.create()
    const form = doc.context.register(
      doc.context.formXObject(settingText('F', 1), { BBox: [0, 0, 10, 10] })
    )
    for (const font of [
      ['MS-Mincho', 'identity'],
      ['Century', 'simple'],
    ] as FontSpec[]) {
      const page = doc.addPage()
      page.node.setFontDictionary(PDFName.of('F0'), fontOf(doc, font))
      page.node.setXObject(PDFName.of('Fm0'), form)
      page.pushOperators(drawObject('Fm0'))
    }
    const path = await file('shared-form.pdf', Buffer.from(await doc.save()))

    expect(await blocks(path, 'pdf')).toEqual([
      { loc: { page: 1 }, text: '', unreadable: 'unmapped-fonts', unmappedChars: 2 },
      { loc: { page: 2 }, text: 'AA' },
    ])
  })

  it('names a font as pdf.js does: its BaseFont where it is its FontName and more', async () => {
    parseOffice.mockResolvedValue(
      astOf([pageOfRuns(1, [run('ࡢࡢ', 'Lato-Medium')])], { metadata: { pages: 1 } })
    )
    const path = await file(
      'font-name.pdf',
      await pdfWithFonts([[['Lato-Medium', 'identity', 'Lato']]])
    )

    expect(await blocks(path, 'pdf')).toEqual([
      { loc: { page: 1 }, text: '', unreadable: 'unmapped-fonts', unmappedChars: 2 },
    ])
  })

  it("judges a font of Adobe's character collections neither way, pdf.js giving no text for it", async () => {
    parseOffice.mockResolvedValue(
      astOf(
        [
          pageOfRuns(1, [run('第２表', 'RyuminPr6N-Light')]),
          // Without the CMaps officeparser does not pass, a run with no font
          // named cannot be one the collection's font set
          pageOfRuns(2, [{ type: 'text', text: 'ࡢࡀ', formatting: {} } as OfficeContentNode]),
        ],
        { metadata: { pages: 2 } }
      )
    )
    const path = await file(
      'japan1.pdf',
      await pdfWithFonts([
        [['RyuminPr6N-Light', 'japan1']],
        [
          ['RyuminPr6N-Light', 'japan1'],
          ['MS-PMincho', 'identity'],
        ],
      ])
    )

    expect(await blocks(path, 'pdf')).toEqual([
      { loc: { page: 1 }, text: '第２表' },
      { loc: { page: 2 }, text: '', unreadable: 'unmapped-fonts', unmappedChars: 2 },
    ])
  })

  it('judges the fonts of a PDF encrypted for anyone to open', async () => {
    parseOffice.mockResolvedValue(
      astOf([pageOfRuns(1, [run('ࡢࡀ㈤㔠', 'MS-Mincho')])], { metadata: { pages: 1 } })
    )
    const path = await file(
      'encrypted.pdf',
      await pdfWithFonts([[['MS-Mincho', 'identity']]], { encrypted: true })
    )

    expect(await blocks(path, 'pdf')).toEqual([
      { loc: { page: 1 }, text: '', unreadable: 'unmapped-fonts', unmappedChars: 4 },
    ])
  })

  it('keeps text in a font of a name a mapped font on the page has too', async () => {
    parseOffice.mockResolvedValue(
      astOf([pageOfRuns(1, [run('本文', 'MS-Mincho')])], { metadata: { pages: 1 } })
    )
    const path = await file(
      'shared-name.pdf',
      await pdfWithFonts([
        [
          ['MS-Mincho', 'identity'],
          ['MS-Mincho', 'simple'],
        ],
      ])
    )

    expect(await blocks(path, 'pdf')).toEqual([{ loc: { page: 1 }, text: '本文' }])
  })

  /** A font of glyph numbers whose ToUnicode maps `body`, embedded as writers do. */
  const partly = (name: string, body: string): FontSpec => [
    name,
    'identity',
    undefined,
    { toUnicode: body, embedded: true },
  ]

  it('leaves out the characters a partial ToUnicode does not give, counts them, and marks a page mostly of them', async () => {
    parseOffice.mockResolvedValue(
      astOf(
        [
          // `年` and `９`, which it leaves out, as the characters of their glyphs' numbers
          pageOfRuns(1, [run('平成0ᖺ度 あぃい fi ſt', 'MS-Mincho')]),
          pageOfRuns(2, [run('ᖺ㸵ᖺ平', 'MS-Mincho')]),
        ],
        { metadata: { pages: 2 } }
      )
    )
    const font = partly(
      'MS-Mincho',
      [
        '4 beginbfchar',
        '<0013> <0030>',
        '<1414> <5E73>',
        // Ligatures, which pdf.js gives as their letters: `ﬅ` as `ſt`, not as NFKC's `st`
        '<0050> <FB01>',
        '<0051> <FB05>',
        'endbfchar',
        '2 beginbfrange',
        '<0836> <0838> <3042>',
        '<0900> <0901> [<6210> <5EA6>]',
        'endbfrange',
      ].join('\n')
    )
    const path = await file('partly.pdf', await pdfWithFonts([[font], [font]]))

    expect(await blocks(path, 'pdf')).toEqual([
      { loc: { page: 1 }, text: '平成0度 あぃい fi ſt', unmappedChars: 1 },
      { loc: { page: 2 }, text: '平', unreadable: 'unmapped-fonts', unmappedChars: 3 },
    ])
  })

  it('keeps what a simple font of the same name gives through its encoding, but not glyph numbers past it', async () => {
    parseOffice.mockResolvedValue(
      // `の` as its glyph's number, in Latin Extended
      astOf([pageOfRuns(1, [run('あƷ12 é', 'lrSVbN')])], { metadata: { pages: 1 } })
    )
    const path = await file(
      'shared-simple.pdf',
      await pdfWithFonts([
        [
          partly('lrSVbN', '1 beginbfchar\n<0836> <3042>\nendbfchar'),
          [
            'lrSVbN',
            'simple',
            undefined,
            { toUnicode: '1 beginbfrange\n<30> <39> <0030>\nendbfrange' },
          ],
        ],
      ])
    )

    expect(await blocks(path, 'pdf')).toEqual([
      { loc: { page: 1 }, text: 'あ12 é', unmappedChars: 1 },
    ])
  })

  it('judges a run by the font whose own name ends as officeparser tells two of a name apart', async () => {
    parseOffice.mockResolvedValue(
      astOf([pageOfRuns(1, [run('\uF028ᖺ\uF029', 'MS-Mincho+1')])], { metadata: { pages: 1 } })
    )
    const path = await file(
      'plus-one.pdf',
      await pdfWithFonts([
        [partly('MS-Mincho+1', '2 beginbfchar\n<000A> <F028>\n<000B> <F029>\nendbfchar')],
      ])
    )

    expect(await blocks(path, 'pdf')).toEqual([{ loc: { page: 1 }, text: '()', unmappedChars: 1 }])
  })

  it('keeps any text where the page draws a composite font the file does not embed, whose runs can carry another name', async () => {
    parseOffice.mockResolvedValue(
      astOf([pageOfRuns(1, [run('あ', 'MS-Mincho'), run('-40-', 'MS-Mincho')])], {
        metadata: { pages: 1 },
      })
    )
    const path = await file(
      'not-embedded.pdf',
      await pdfWithFonts([
        [partly('MS-Mincho', '1 beginbfchar\n<0836> <3042>\nendbfchar'), ['MS-PGothic', 'unicode']],
      ])
    )

    expect(await blocks(path, 'pdf')).toEqual([{ loc: { page: 1 }, text: 'あ\n-40-' }])
  })

  it('judges no character of a font whose ToUnicode maps more codes than two bytes have, or too long a value', async () => {
    parseOffice.mockResolvedValue(
      astOf([pageOfRuns(1, [run('ᖺ度', 'MS-Mincho')]), pageOfRuns(2, [run('ᖺ度', 'Gothic')])], {
        metadata: { pages: 2 },
      })
    )
    // Each range alone within bounds, as a file made to cost its reader would have them
    const ranges = Array.from({ length: 50 }, () => '<0000> <FFFF> <5EA6>').join('\n')
    const path = await file(
      'overlong.pdf',
      await pdfWithFonts([
        [partly('MS-Mincho', `50 beginbfrange\n${ranges}\nendbfrange`)],
        [partly('Gothic', `1 beginbfchar\n<0901> <${'5EA6'.repeat(17)}>\nendbfchar`)],
      ])
    )

    expect(await blocks(path, 'pdf')).toEqual([
      { loc: { page: 1 }, text: 'ᖺ度' },
      { loc: { page: 2 }, text: 'ᖺ度' },
    ])
  })

  it('reads a value of an odd number of digits, or of bytes, as pdf.js does', async () => {
    parseOffice.mockResolvedValue(
      astOf([pageOfRuns(1, [run('一Aあᖺ', 'MS-Mincho')])], { metadata: { pages: 1 } })
    )
    const path = await file(
      'cmap-odd.pdf',
      await pdfWithFonts([
        // `<4E0>` as `<4E00>`, `一`; `<41>` as `<0041>`, `A`; `<003042>` as `<00003042>`, `あ`
        [
          partly(
            'MS-Mincho',
            '3 beginbfchar\n<0836> <4E0>\n<0837> <41>\n<0838> <003042>\nendbfchar'
          ),
        ],
      ])
    )

    expect(await blocks(path, 'pdf')).toEqual([
      { loc: { page: 1 }, text: '一Aあ', unmappedChars: 1 },
    ])
  })

  it('reads entries written as literal strings, with their escapes, as pdf.js does', async () => {
    parseOffice.mockResolvedValue(
      astOf([pageOfRuns(1, [run('あい()ᖺ', 'MS-Mincho')])], { metadata: { pages: 1 } })
    )
    const body = [
      '3 beginbfchar',
      // Octal escapes: `\060\102` is 0x30 0x42, `あ`
      String.raw`(\000\001) (\060\102)`,
      // A backslash before a line break continues the string: `0D`, `い`
      '<0002> (0\\\nD)',
      // Escaped parentheses: 0x0028 0x0029
      String.raw`<0003> (\000\(\000\))`,
      'endbfchar',
    ].join('\n')
    const path = await file('cmap-literal.pdf', await pdfWithFonts([[partly('MS-Mincho', body)]]))

    expect(await blocks(path, 'pdf')).toEqual([
      { loc: { page: 1 }, text: 'あい()', unmappedChars: 1 },
    ])
  })

  it('reads a ToUnicode with comments in it, and judges none with what it cannot read', async () => {
    parseOffice.mockResolvedValue(
      astOf([pageOfRuns(1, [run('あᖺ', 'MS-Mincho')]), pageOfRuns(2, [run('あᖺ', 'Gothic')])], {
        metadata: { pages: 2 },
      })
    )
    const path = await file(
      'cmap-comments.pdf',
      await pdfWithFonts([
        [partly('MS-Mincho', '% maps\n1 beginbfchar\n<0836> % あ\n<3042>\nendbfchar')],
        // An entry in a form it does not read, whose character would be taken out
        [partly('Gothic', '2 beginbfchar\n<0836> <3042>\n<0837> /uni3044\nendbfchar')],
      ])
    )

    expect(await blocks(path, 'pdf')).toEqual([
      { loc: { page: 1 }, text: 'あ', unmappedChars: 1 },
      { loc: { page: 2 }, text: 'あᖺ' },
    ])
  })

  it('reads a ToUnicode made to cost its reader in a time its length bounds', async () => {
    parseOffice.mockResolvedValue(
      astOf([pageOfRuns(1, [run('あᖺ', 'MS-Mincho')]), pageOfRuns(2, [run('あᖺ', 'Gothic')])], {
        metadata: { pages: 2 },
      })
    )
    const started = performance.now()
    const path = await file(
      'cmap-slow.pdf',
      await pdfWithFonts([
        // Strings and sections that never end, each read to the end of the map from every start
        [partly('MS-Mincho', '('.repeat(60_000))],
        [partly('Gothic', 'beginbfchar <0836> <3042> '.repeat(20_000))],
      ])
    )

    expect(await blocks(path, 'pdf')).toEqual([
      { loc: { page: 1 }, text: 'あᖺ' },
      { loc: { page: 2 }, text: 'あᖺ' },
    ])
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('judges no character of a font whose ToUnicode takes another CMap in', async () => {
    parseOffice.mockResolvedValue(
      astOf([pageOfRuns(1, [run('ᖺ度', 'MS-Mincho')])], { metadata: { pages: 1 } })
    )
    const path = await file(
      'usecmap.pdf',
      await pdfWithFonts([
        [
          partly(
            'MS-Mincho',
            '/Adobe-Japan1-UCS2 usecmap\n1 beginbfchar\n<0901> <5EA6>\nendbfchar'
          ),
        ],
      ])
    )

    expect(await blocks(path, 'pdf')).toEqual([{ loc: { page: 1 }, text: 'ᖺ度' }])
  })

  it("reads the codes of an ordinary font flagged as symbolic as ASCII, and not a symbol font's", async () => {
    parseOffice.mockResolvedValue(
      astOf(
        [
          pageOfRuns(1, [
            run('平成\uF031\uF039年度\uF028Ａ\uF029', 'MS-Mincho+1'),
            run('\uF0D8\uF06C 住宅火災', 'Wingdings'),
          ]),
        ],
        { metadata: { pages: 1 } }
      )
    )
    const path = await file('symbolic.pdf', await pdfWithFonts([[]]))

    expect(await blocks(path, 'pdf')).toEqual([
      { loc: { page: 1 }, text: '平成19年度(Ａ)\n\uF0D8\uF06C 住宅火災' },
    ])
  })

  it('asks for the headings the tags mark, never those the font size suggests', async () => {
    parseOffice.mockResolvedValue(astOf([page(1, 'a')], { metadata: { pages: 1 } }))
    const path = await file('asked.pdf', Buffer.alloc(10))

    await blocks(path, 'pdf')
    for (const [, config] of parseOffice.mock.calls) {
      expect((config as OfficeParserConfig).pdfParserConfig?.headingDetection).toBe('tags')
    }
  })

  it('without bookmarks, splits each page at its tagged headings, across pages and ranges', async () => {
    parseOffice.mockImplementation(async (_path, config) => {
      const pages =
        rangeOf(config) === '1-3'
          ? [
              tagged(1, [p('cover')]),
              tagged(2, [h(1, '第1章'), p('a'), h(2, '1.1 目的'), p('b')]),
              tagged(3, [p('c'), h(2, '1.2 範囲'), p('d')]),
            ]
          : [tagged(4, [p('e'), h(1, '第2章')])]
      return astOf(pages, { metadata: { pages: 4 } })
    })
    const path = await file('tagged.pdf', Buffer.alloc(4 * 1024 * 1024))

    expect(await blocks(path, 'pdf')).toEqual([
      { loc: { page: 1 }, text: 'cover' },
      { loc: { page: 2 }, headings: ['第1章'], text: '第1章\na' },
      { loc: { page: 2 }, headings: ['第1章', '1.1 目的'], text: '1.1 目的\nb' },
      // The page opens under the headings the page before ended under
      { loc: { page: 3 }, headings: ['第1章', '1.1 目的'], text: 'c' },
      { loc: { page: 3 }, headings: ['第1章', '1.2 範囲'], text: '1.2 範囲\nd' },
      { loc: { page: 4 }, headings: ['第1章', '1.2 範囲'], text: 'e' },
      { loc: { page: 4 }, headings: ['第2章'], text: '第2章' },
    ])
  })

  it('reads the bookmarks, not the tags, where a PDF has both', async () => {
    parseOffice.mockResolvedValue(
      astOf([tagged(1, [h(1, 'tag'), p('a'), h(2, 'sub'), p('b')])], {
        metadata: { pages: 1 },
        auxiliary: { outline: [bookmark('しおり', '#page=1')] },
      })
    )
    const path = await file('both.pdf', Buffer.alloc(10))

    expect(await blocks(path, 'pdf')).toEqual([
      { loc: { page: 1 }, headings: ['しおり'], text: 'tag\na\nsub\nb' },
    ])
  })

  it('leaves out a run with no text, so the runs are the page text', async () => {
    parseOffice.mockResolvedValue(
      astOf([tagged(1, [node('table', ''), h(1, 'A'), p('a')]), tagged(2, [])], {
        metadata: { pages: 2 },
      })
    )
    const path = await file('empty-run.pdf', Buffer.alloc(10))

    expect(await blocks(path, 'pdf')).toEqual([
      { loc: { page: 1 }, headings: ['A'], text: 'A\na' },
      { loc: { page: 2 }, headings: ['A'], text: '', unreadable: 'no-text' },
    ])
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

  it('titles a heading by its text, a line break in it a space between its words', async () => {
    parseOffice.mockResolvedValue(
      astOf([
        node('heading', 'Annual\nreport', { level: 1 }, [
          node('text', 'Annual'),
          node('break', ''),
          node('text', 'report'),
        ]),
        node('paragraph', 'body'),
      ])
    )
    const path = await file('break.docx', Buffer.alloc(10))

    expect((await blocks(path, 'docx')).map((b) => b.headings)).toEqual([['Annual report']])
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

describe('XLS', () => {
  it('reads the worksheets in tab order by number and name, a row per line, cells left to right', async () => {
    const path = await file(
      'a.xls',
      xlsBuffer({
        sst: biff(0x00fc, sstData(['人口', 'Tokyo'])),
        sheets: [
          {
            name: '人口',
            cells: [
              // Written out of column order, and with a row left empty
              cell.number(0, 2, 1.25),
              cell.labelSst(0, 0, 0),
              cell.label(2, 0, '区部'),
              cell.rk(2, 1, rkInt(9_733_276)),
              cell.mulrk(3, 1, [rkInt(1234, true), rkDouble(0.25), rkInt(-5)]),
            ],
          },
          // A chart sheet: counted in the tabs, with no cells to read
          { name: 'グラフ' },
          { name: 'en', cells: [cell.labelSst(4, 3, 1)] },
        ],
      })
    )
    expect(await blocks(path, 'xls')).toEqual([
      {
        loc: { sheet: 1, sheetName: '人口', rows: [1, 3, 4] },
        text: '人口\t1.25\n区部\t9733276\n12.34\t0.25\t-5',
      },
      { loc: { sheet: 3, sheetName: 'en', rows: [5] }, text: 'Tokyo' },
    ])
  })

  it("gives a formula's last result, and a cell's boolean or error, as an XLSX's cell gives them", async () => {
    const path = await file(
      'formula.xls',
      xlsBuffer({
        sheets: [
          {
            name: 's',
            cells: [
              cell.formula(0, 0, 42),
              cell.formula(0, 1, '合計'),
              cell.formula(0, 2, true),
              cell.formula(0, 3, { error: 0x07 }),
              cell.boolerr(1, 0, 0, false),
              cell.boolerr(1, 1, 0x2a, true),
              // An empty string result is no cell
              cell.formula(1, 2, ''),
            ],
          },
        ],
      })
    )
    expect(await lines(path, 'xls')).toEqual(['42\t合計\t1\t#DIV/0!\n0\t#N/A'])
  })

  it('reads a shared string that runs on into a CONTINUE, its width changing there, and leaves its phonetic reading out', async () => {
    // 東京都 starts in the SST as UTF-16, its last character in a CONTINUE that
    // starts with a flags byte of its own; the next string has a reading after it
    const head = Buffer.alloc(8)
    head.writeUInt32LE(3, 0)
    head.writeUInt32LE(3, 4)
    const first = Buffer.concat([Buffer.from([4, 0, 0x01]), Buffer.from('東京', 'utf16le')])
    const rest = Buffer.concat([Buffer.from([0x01]), Buffer.from('都x', 'utf16le')])
    const reading = Buffer.from('ミナト', 'utf16le')
    const phonetic = Buffer.concat([
      Buffer.from([2, 0, 0x05]),
      Buffer.from([reading.length, 0, 0, 0]),
      Buffer.from('港区', 'utf16le'),
      reading,
    ])
    const plain = Buffer.concat([Buffer.from([2, 0, 0x00]), Buffer.from('ab', 'latin1')])
    const path = await file(
      'continue.xls',
      xlsBuffer({
        sst: Buffer.concat([
          biff(0x00fc, Buffer.concat([head, first])),
          biff(0x003c, Buffer.concat([rest, phonetic, plain])),
        ]),
        sheets: [{ name: 's', cells: [0, 1, 2].map((i) => cell.labelSst(i, 0, i)) }],
      })
    )
    expect(await lines(path, 'xls')).toEqual(['東京都x\n港区\nab'])
  })

  it("reads a BIFF5 workbook's strings in its code page", async () => {
    // 東京 in Shift_JIS
    const tokyo = Buffer.from([0x93, 0x8c, 0x8b, 0x9e])
    const path = await file(
      'biff5.xls',
      xlsBuffer({
        biff5: true,
        globals: [biff(0x0042, Buffer.from([0xa4, 0x03]))],
        sheets: [{ name: tokyo, cells: [cell.label5(0, 0, tokyo), cell.number(0, 1, 3)] }],
      })
    )
    expect(await blocks(path, 'xls')).toEqual([
      { loc: { sheet: 1, sheetName: '東京', rows: [1] }, text: '東京\t3' },
    ])
  })

  it('reads a sheet past a chart drawn on it, whose records are not its cells', async () => {
    const path = await file(
      'chart.xls',
      xlsBuffer({
        sheets: [
          {
            name: 's',
            cells: [
              cell.label(0, 0, 'before'),
              chartSubstream([cell.label(5, 5, 'in the chart')]),
              cell.label(1, 0, 'after'),
            ],
          },
        ],
      })
    )
    expect(await lines(path, 'xls')).toEqual(['before\nafter'])
  })

  it('reads a workbook large enough for its stream to be outside the mini stream', async () => {
    const rows = Array.from({ length: 400 }, (_, i) => cell.label(i, 0, `row ${i}`))
    const path = await file('large.xls', xlsBuffer({ sheets: [{ name: 's', cells: rows }] }))
    const text = (await lines(path, 'xls')).join('\n').split('\n')
    expect(text).toHaveLength(400)
    expect(text[399]).toBe('row 399')
  })

  it('refuses an encrypted workbook, and a file that is not a compound file', async () => {
    const encrypted = await file(
      'encrypted.xls',
      xlsBuffer({
        globals: [biff(0x002f, Buffer.alloc(54))],
        sheets: [{ name: 's', cells: [cell.label(0, 0, 'x')] }],
      })
    )
    await expect(blocks(encrypted, 'xls')).rejects.toThrow('XLS is encrypted')
    // A page published as a workbook
    const html = await file('page.xls', Buffer.from('<html><table><tr><td>1</td></tr></table>'))
    await expect(blocks(html, 'xls')).rejects.toThrow('Not a compound file')
  })

  it('reads a sheet that several BOUNDSHEETs point at once', async () => {
    const path = await file(
      'same.xls',
      xlsBuffer({
        sheets: ['a', 'b', 'c'].map((name) => ({ name, cells: [cell.label(0, 0, name)] })),
        offsets: (at) => at.map(() => at[0]),
      })
    )
    expect(await lines(path, 'xls')).toEqual(['a'])
  })

  it('refuses sheets that start each inside the last, which would have it walk the stream for each', async () => {
    // Ten BOFs one after another, the BOUNDSHEETs pointing at each: every walk
    // runs on to the end of the outermost, over all the cells
    const nested = 10
    const cells = Array.from({ length: 2_000 }, (_, i) => cell.label(i, 0, `row ${i}`))
    const path = await file(
      'nested.xls',
      xlsBuffer({
        sheets: Array.from({ length: nested }, (_, i) => ({
          name: `s${i}`,
          cells:
            i === 0
              ? [
                  ...Array(nested - 1).fill(bof(0x0010)),
                  ...cells,
                  ...Array(nested - 1).fill(EOF_RECORD),
                ]
              : [],
        })),
        offsets: (at) => at.map((_, i) => at[0] + i * bof(0x0010).length),
      })
    )
    await expect(blocks(path, 'xls')).rejects.toThrow('over and over')
  })

  it("counts the CONTINUEs a sheet's records run on into in what walking it costs", async () => {
    // Ten BOFs one after another, as above, and a record running on into CONTINUEs that dwarf the rest
    const nested = 10
    const continues = Array.from({ length: 20 }, () => biff(0x003c, Buffer.alloc(8_000)))
    const path = await file(
      'continues.xls',
      xlsBuffer({
        sheets: Array.from({ length: nested }, (_, i) => ({
          name: `s${i}`,
          cells:
            i === 0
              ? [
                  ...Array<Buffer>(nested - 1).fill(bof(0x0010)),
                  cell.number(0, 0, 1),
                  ...continues,
                  ...Array<Buffer>(nested - 1).fill(EOF_RECORD),
                ]
              : [],
        })),
        offsets: (at) => at.map((_, i) => at[0] + i * bof(0x0010).length),
      })
    )
    await expect(blocks(path, 'xls')).rejects.toThrow('over and over')
  })

  it('reads a compound file whose last sector is cut short, its padding left off', async () => {
    const whole = xlsBuffer({ sheets: [{ name: 's', cells: [cell.label(0, 0, 'x')] }] })
    let end = whole.length
    while (end > 0 && whole[end - 1] === 0) end--
    expect(end).toBeLessThan(whole.length)
    const path = await file('short.xls', whole.subarray(0, end))
    expect(await lines(path, 'xls')).toEqual(['x'])
  })

  it('refuses a workbook whose text comes to more than the limit, many cells naming one long string', async () => {
    const long = 'あ'.repeat(30_000)
    const path = await file(
      'amplified.xls',
      xlsBuffer({
        sst: biff(0x00fc, sstData([long])),
        sheets: [
          { name: 's', cells: Array.from({ length: 100 }, (_, i) => cell.labelSst(i, 0, 0)) },
        ],
      })
    )
    await expect(extractDocumentText(path, 'xls', join(dir, 'out.zst'))).rejects.toThrow(
      'Document text is over'
    )
  })

  it('refuses a compound file that counts more FAT sectors than it has', async () => {
    const bytes = xlsBuffer({ sheets: [{ name: 's', cells: [cell.label(0, 0, 'x')] }] })
    bytes.writeUInt32LE(1_000_000, 0x2c)
    await expect(blocks(await file('fat.xls', bytes), 'xls')).rejects.toThrow('FAT sectors')
  })

  it('refuses a compound file whose directory loops', async () => {
    const bytes = xlsBuffer({ sheets: [{ name: 's', cells: [cell.label(0, 0, 'x')] }] })
    // The stream's entry, the second in the directory, made its own right sibling
    const directory = (bytes.readUInt32LE(0x30) + 1) * 512
    bytes.writeUInt32LE(1, directory + 128 + 0x48)
    await expect(blocks(await file('loop.xls', bytes), 'xls')).rejects.toThrow('loop')
  })
})

describe('DOC', () => {
  it('reads the body, footnotes, endnotes and text boxes, but not the headers or comments, a paragraph a line', async () => {
    const path = await file(
      'a.doc',
      docBuffer(
        [
          { text: 'Title\r', compressed: true },
          { text: '本文です。\r' },
          { text: 'footnote\r', compressed: true },
          { text: 'page 1\r', compressed: true },
          { text: 'a comment\r', compressed: true },
          { text: '後注\r' },
          { text: 'テキストボックス\r' },
        ],
        { body: 12, footnotes: 9, headers: 7, comments: 10, endnotes: 3, boxes: 9 }
      )
    )
    expect(await blocks(path, 'doc')).toEqual([
      { loc: {}, text: 'Title\n本文です。\n\nfootnote\n\n後注\n\nテキストボックス\n' },
    ])
  })

  it("keeps a field's result and leaves out its instructions, nested or not, and reads Word's breaks", async () => {
    const text =
      'See \x13 HYPERLINK "https://example.jp" \x14the site\x15.\r' +
      '\x13 PAGE \x15Page\x13 = \x13 PAGE \x14 2 \x15 + 1 \x143\x15\x0bnext\x07cell\x07\x07\x01end\x1ehyphen\r'
    const path = await file('fields.doc', docBuffer([{ text }], { body: text.length }))
    expect(await lines(path, 'doc')).toEqual(['See the site.\nPage3\nnext\ncell\n\nend-hyphen\n'])
  })

  it('refuses an encrypted document, and one from before Word 97', async () => {
    const encrypted = await file(
      'encrypted.doc',
      docBuffer([{ text: 'x\r' }], { body: 2 }, { flags: 0x0200 | 0x0100 })
    )
    await expect(blocks(encrypted, 'doc')).rejects.toThrow('DOC is encrypted')
    const word95 = await file(
      'word95.doc',
      docBuffer([{ text: 'x\r' }], { body: 2 }, { nFib: 0x65 })
    )
    await expect(blocks(word95, 'doc')).rejects.toThrow('before Word 97')
  })

  it('builds no more text than its stream has bytes, whatever its pieces point at', async () => {
    // Ten thousand pieces, each the same 11 characters, in a stream of under 1,000 bytes
    const path = await file(
      'repeated.doc',
      docBuffer([{ text: 'abcdefghij\r' }], { body: 110_000 }, { repeat: 10_000 })
    )
    const text = (await lines(path, 'doc')).join('')
    expect(text.length).toBeGreaterThan(0)
    expect(text.length).toBeLessThan(1_000)
  })

  it('reads fields nested as deep as a file makes them in a time its length bounds', async () => {
    // Each field past its separator, so every character is in all their results
    const depth = 150_000
    const text = '\x13\x14'.repeat(depth) + 'x'.repeat(depth)
    const path = await file('nested.doc', docBuffer([{ text }], { body: text.length }))
    const started = performance.now()
    expect(await lines(path, 'doc')).toEqual(['x'.repeat(depth)])
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('refuses a property modifier whose size is negative, which would read it forever', async () => {
    const path = await file('prc.doc', docBuffer([{ text: 'x\r' }], { body: 2 }, { prcSize: -3 }))
    await expect(blocks(path, 'doc')).rejects.toThrow('negative size')
  })

  it('reads the table stream the FIB names, 0Table as well as 1Table', async () => {
    const path = await file(
      '0table.doc',
      docBuffer([{ text: 'zero\r' }], { body: 5 }, { flags: 0 })
    )
    expect(await lines(path, 'doc')).toEqual(['zero\n'])
  })
})

describe('PPT', () => {
  it('reads the slides in the order of their list, under their titles, with the text of their own shapes', async () => {
    const path = await file(
      'a.ppt',
      pptBuffer([
        {
          objects: {
            1: pptDocument([
              {
                ref: 3,
                records: [
                  ppt.header(0),
                  ppt.chars('計画の概要\r'),
                  ppt.header(1),
                  ppt.chars('目的\r背景'),
                ],
              },
              { ref: 2, records: [] },
            ]),
            2: ppt.slide([ppt.bytes('Appendix'), ppt.chars('表\x0bの説明')]),
            // A shape that copies its placeholder's text is not read twice
            3: ppt.slide([ppt.chars('図1'), ppt.chars('計画の概要')]),
            4: ppt.notes([ppt.chars('Notes are not slides')]),
          },
        },
      ])
    )
    expect(await blocks(path, 'ppt')).toEqual([
      { loc: { slide: 1 }, headings: ['計画の概要'], text: '計画の概要\n目的\n背景\n図1' },
      { loc: { slide: 2 }, text: 'Appendix\n表\nの説明' },
    ])
  })

  it('reads each object where the latest edit to write it put it', async () => {
    const slides = (title: string) =>
      pptDocument([{ ref: 2, records: [ppt.header(0), ppt.chars(title)] }])
    const path = await file(
      'edited.ppt',
      pptBuffer([
        { objects: { 1: slides('first'), 2: ppt.slide([ppt.chars('old shape')]) } },
        { objects: { 2: ppt.slide([ppt.chars('new shape')]) } },
        { objects: { 1: slides('latest') } },
      ])
    )
    expect(await blocks(path, 'ppt')).toEqual([
      { loc: { slide: 1 }, headings: ['latest'], text: 'latest\nnew shape' },
    ])
  })

  it("reads a slide's own text once, however often the list names it", async () => {
    const path = await file(
      'refs.ppt',
      pptBuffer([
        {
          objects: {
            1: pptDocument([1, 2, 3].map(() => ({ ref: 2, records: [] }))),
            2: ppt.slide([ppt.chars('shape')]),
          },
        },
      ])
    )
    const text = (await lines(path, 'ppt')).join('\n')
    expect(text.match(/shape/g)).toHaveLength(1)
  })

  it("reads a slide's own text once, however many ids name where it is", async () => {
    const path = await file(
      'aliases.ppt',
      pptBuffer([
        {
          objects: {
            1: pptDocument([2, 3, 4].map((ref) => ({ ref, records: [] }))),
            2: ppt.slide([ppt.chars('shape')]),
          },
          aliases: { 3: { of: 2 }, 4: { of: 2 } },
        },
      ])
    )
    const text = (await lines(path, 'ppt')).join('\n')
    expect(text.match(/shape/g)).toHaveLength(1)
  })

  it('refuses slides whose records hold each other, which would read the same text for each', async () => {
    // Five slides, each inside the last's drawing, the list naming each of them
    let slide = ppt.slide([ppt.chars('x'.repeat(20_000))])
    for (let i = 0; i < 4; i++) slide = ppt.slide([slide])
    // A slide's record starts five headers into the one holding it
    const aliases = Object.fromEntries([1, 2, 3, 4].map((n) => [n + 2, { of: 2, plus: 40 * n }]))
    const path = await file(
      'nested.ppt',
      pptBuffer([
        {
          objects: {
            1: pptDocument([2, 3, 4, 5, 6].map((ref) => ({ ref, records: [] }))),
            2: slide,
          },
          aliases,
        },
      ])
    )
    await expect(blocks(path, 'ppt')).rejects.toThrow('more text than it holds')
  })

  it('refuses edits that all name one persist directory, which would have it read for each', async () => {
    // One directory of many objects, then a hundred edits that point back at it
    const objects = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [i + 2, ppt.slide([ppt.chars(`s${i}`)])])
    )
    const path = await file(
      'directories.ppt',
      pptBuffer([
        { objects: { 1: pptDocument([]), ...objects } },
        ...Array.from({ length: 100 }, () => ({ objects: {}, reuseDirectory: true })),
      ])
    )
    await expect(blocks(path, 'ppt')).rejects.toThrow('over and over')
  })

  it('refuses an encrypted presentation', async () => {
    const objects = { 1: pptDocument([]) }
    const token = await file('token.ppt', pptBuffer([{ objects }], { token: 0xf3d1c4df }))
    await expect(blocks(token, 'ppt')).rejects.toThrow('PPT is encrypted')
    const edit = await file('edit.ppt', pptBuffer([{ objects }], { encrypted: true }))
    await expect(blocks(edit, 'ppt')).rejects.toThrow('PPT is encrypted')
  })
})

describe('Ichitaro', () => {
  it("reads a block's text to its declared end, a record's parameters left out, a cell's end a tab", async () => {
    const path = await file(
      'a.jtd',
      jtdBuffer({
        DocumentText: jtdStream({
          blocks: [
            [
              '申請書',
              0x0a,
              // A paragraph's record: printable parameters, and one that is 0x001D
              ...jtd.record(0x10, [0x24, 0x1d, 0x1e, 0x44]),
              '住所',
              ...jtd.record(0x30, [0x0c, 0x50]),
              '氏名',
              0x0a,
            ],
          ],
          // The style section after the block's end
          tail: [0x1f, '書式'],
        }),
      })
    )
    expect(await blocks(path, 'jtd')).toEqual([{ loc: {}, text: '申請書\n住所\t氏名' }])
  })

  it("shows a ruby's base where it stands, and gives its reading at the end of its line", async () => {
    const path = await file(
      'ruby.jtd',
      jtdBuffer({
        DocumentText: jtdStream({
          blocks: [
            [
              '一、',
              ...jtd.inline(true, '午后'),
              ...jtd.inline(false, 'ごご'),
              'の授業',
              0x0a,
              '二',
            ],
          ],
        }),
      })
    )
    expect(await lines(path, 'jtd')).toEqual(['一、午后の授業 ごご\n二'])
  })

  it('reads the layout boxes after the body, a block a line', async () => {
    const path = await file(
      'boxes.jtd',
      jtdBuffer({
        DocumentText: jtdStream({ blocks: [['本文']] }),
        LayoutBoxText: jtdStream({ blocks: [['見出し'], [...jtd.record(0x10, [1]), '枠の中']] }),
      })
    )
    expect(await lines(path, 'jtd')).toEqual(['本文\n見出し\n枠の中'])
  })

  it('reads a sheet after the first from its storage, a block a sheet in the order of their names', async () => {
    const path = await file(
      'sheets.jtd',
      jtdBuffer({
        DocumentText: jtdStream({ blocks: [['表紙']] }),
        'ObjectSheets/DocSheet/DOCS_0002/DocumentText': jtdStream({ blocks: [['三枚目']] }),
        'ObjectSheets/DocSheet/DOCS_0001/DocumentText': jtdStream({ blocks: [['二枚目']] }),
        'ObjectSheets/DocSheet/DOCS_0001/LayoutBoxText': jtdStream({ blocks: [['枠']] }),
        'ObjectSheets/DocSheet/DocItemInfo': Buffer.alloc(8),
      })
    )
    expect(await blocks(path, 'jtd')).toEqual([
      { loc: { sheet: 1 }, text: '表紙' },
      { loc: { sheet: 2 }, text: '二枚目\n枠' },
      { loc: { sheet: 3 }, text: '三枚目' },
    ])
  })

  it('refuses sheets that read the same text over and over', async () => {
    // Read for each sheet, one large stream would make text out of proportion to the file
    const sheets = Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [
        `ObjectSheets/DocSheet/DOCS_000${i}/DocumentText`,
        jtdStream({ blocks: [['枚']] }),
      ])
    )
    const path = await file(
      'shared.jtd',
      sharingSectors(
        jtdBuffer({ DocumentText: jtdStream({ blocks: [['本文'.repeat(5_000)]] }), ...sheets }),
        'DocumentText'
      )
    )
    await expect(blocks(path, 'jtd')).rejects.toThrow('over and over')
  })

  it('reads a stream only as far as its size, not on along its chain', async () => {
    // Walked whole for a few bytes, a long chain named by many sheets would go uncounted
    const body = jtdStream({ blocks: [['本'.repeat(3_000)]] })
    const path = await file(
      'cut.jtd',
      cutShort(jtdBuffer({ DocumentText: body }), 'DocumentText', 4_608)
    )
    const [block] = await blocks(path, 'jtd')
    expect(block!.text).toMatch(/^本+$/)
  })

  it('refuses storages nested past any document', async () => {
    const deep = `${Array.from({ length: 40 }, (_, i) => `S${i}`).join('/')}/DocumentText`
    const path = await file(
      'deep.jtd',
      jtdBuffer({ DocumentText: jtdStream({ blocks: [['本文']] }), [deep]: Buffer.alloc(4) })
    )
    await expect(blocks(path, 'jtd')).rejects.toThrow('nest too deep')
  })

  it('leaves out an empty sheet, the others keeping their numbers', async () => {
    const path = await file(
      'empty-sheet.jtd',
      jtdBuffer({
        DocumentText: jtdStream({ blocks: [[]] }),
        'ObjectSheets/DocSheet/DOCS_0000/DocumentText': jtdStream({ blocks: [['二枚目']] }),
      })
    )
    expect(await blocks(path, 'jtd')).toEqual([{ loc: { sheet: 2 }, text: '二枚目' }])
  })

  it("reads an older version's text from its markers, leaving out the lines that are not text", async () => {
    const path = await file(
      'old.jtd',
      jtdBuffer({
        DocumentText: jtdStream({
          bare: [
            // Before any marker: not text
            'AB',
            0x1f,
            '本文です',
            0x0a,
            // Formatting read as characters
            0x1f,
            'ĀĀĀĀĀĀ',
            0x0a,
            0x1f,
            '①②・ー',
          ],
        }),
      })
    )
    expect(await lines(path, 'jtd')).toEqual(['本文です\n①②・ー'])
  })

  it('reads on past a record whose length does not reach past its start', async () => {
    // An inline record of length 0, after a 0x001D: its end would be before its start
    const path = await file(
      'zero.jtd',
      jtdBuffer({ DocumentText: jtdStream({ blocks: [['前', 0x1d, 0x1c, 1, 0, 0x1f, '後']] }) })
    )
    expect(await lines(path, 'jtd')).toEqual(['前後'])
  })

  it('reads a line of a great many tabs in a time its length bounds', async () => {
    const path = await file(
      'tabs.jtd',
      jtdBuffer({ DocumentText: jtdStream({ blocks: [['表', '\t'.repeat(100_000), '終']] }) })
    )
    const started = performance.now()
    expect(await lines(path, 'jtd')).toEqual(['表\t終'])
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('keeps a character past the BMP, its surrogate pair read as one', async () => {
    const path = await file(
      'pair.jtd',
      jtdBuffer({ DocumentText: jtdStream({ blocks: [['𠮷野家']] }) })
    )
    expect(await lines(path, 'jtd')).toEqual(['𠮷野家'])
  })

  it('refuses a file with no DocumentText, or one that is not what its signature says', async () => {
    const none = await file('none.jtd', jtdBuffer({ Other: Buffer.from('x') }))
    await expect(blocks(none, 'jtd')).rejects.toThrow('no DocumentText')
    const unsigned = await file('unsigned.jtd', jtdBuffer({ DocumentText: Buffer.alloc(64) }))
    await expect(blocks(unsigned, 'jtd')).rejects.toThrow('signature')
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
    expect(extracted).toEqual({ bytes: Buffer.byteLength('Title\nbody') })
  })

  it('writes control characters as spaces, and Kangxi radicals as the ideographs they look like', async () => {
    parseOffice.mockResolvedValue(
      astOf([
        node('heading', '⽇付', { level: 1 }),
        node('paragraph', '活⽤\u0003する\u0085\tこと\uF039'),
      ])
    )
    const path = await file('a.docx', Buffer.alloc(10))
    const artifact = join(dir, 'text.ndjson.zst')

    await extractDocumentText(path, 'docx', artifact)

    expect(await artifactBlocks(await readFile(artifact))).toEqual([
      // A private-use code is pdf.js's to explain, which an Office document did not pass through
      { loc: {}, headings: ['日付'], text: '日付\n活用 する \tこと\uF039' },
    ])
  })

  it('says there is no text when every block is blank', async () => {
    parseOffice.mockResolvedValue(astOf([page(1, ' '), page(2, '')], { metadata: { pages: 2 } }))
    const path = await file('scan.pdf', Buffer.alloc(10))

    expect(await extractDocumentText(path, 'pdf', join(dir, 'out.zst'))).toEqual({ bytes: 0 })
  })
})
