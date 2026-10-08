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
