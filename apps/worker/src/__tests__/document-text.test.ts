import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OfficeParser, type OfficeParserConfig } from 'officeparser'
import { documentLines } from '../pipeline/steps/document-text'
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

async function lines(path: string, format: string): Promise<string[]> {
  const out: string[] = []
  for await (const line of documentLines(path, format)) out.push(line)
  return out
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

    // A blank line between ranges, as between pages
    expect(await lines(path, 'pdf')).toEqual([
      'pages 1-3',
      '',
      'pages 4-6',
      '',
      'pages 7-9',
      '',
      'pages 10-12',
    ])
    expect(ranges()).toEqual(['1-3', '4-6', '7-9', '10-12'])
  })

  it('leaves out ranges with no text, and the blank lines around them', async () => {
    const texts: Record<string, string> = { '1-3': '', '4-6': 'B', '7-9': '', '10-12': 'D' }
    pdfOf(12, (range) => texts[range])
    const path = await file('gaps.pdf', Buffer.alloc(12 * 1024 * 1024))

    expect(await lines(path, 'pdf')).toEqual(['B', '', 'D'])
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

    expect(await lines(path, 'pdf')).toEqual(['all', 'of it'])
    expect(ranges()).toEqual(['1-3', undefined])
  })
})
