import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib'
import type { DocumentTextBlock } from '@kukan/shared'
import { executeInterpret } from '../../../pipeline/steps/interpret'
import {
  captureUpload,
  createPipelineContextMock,
  type PipelineContextMock,
  type UploadCapture,
} from '../../test-helpers/pipeline-context'
import { artifactBlocks } from '../../test-helpers/document-text'
import { xlsxBuffer } from '../../test-helpers/xlsx'
import { cell, xlsBuffer } from '../../test-helpers/legacy-office'

// Read by the real heavy process: the parsers, not a mock of them

const KEY_RE = (ext: string) => new RegExp(`^previews/pkg-1/res-1\\.[0-9a-f-]{36}\\.${ext}$`)

let ctx: PipelineContextMock
let capture: UploadCapture

beforeEach(() => {
  ctx = createPipelineContextMock()
  capture = captureUpload(ctx)
})

async function interpret(file: Buffer, format: string) {
  ctx.storage.download.mockResolvedValue(Readable.from(file))
  return executeInterpret('res-1', 'pkg-1', { storageKey: 'v1', size: file.length }, format, ctx)
}

function uploaded(ext: string): Buffer | undefined {
  return [...capture.uploads].find(([key]) => KEY_RE(ext).test(key))?.[1]
}

function written(): Promise<DocumentTextBlock[]> {
  return artifactBlocks(uploaded('text\\.ndjson\\.zst')!)
}

/** A PDF of pages with the given text, a blank page for an empty string. */
async function pdfOf(pages: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const text of pages) {
    const page = doc.addPage([400, 400])
    if (text) page.drawText(text, { x: 40, y: 300, size: 12, font })
  }
  return Buffer.from(await doc.save())
}

describe('interpreting a document', () => {
  it('keeps its text a page at a time, and nothing beside it', async () => {
    const result = await interpret(await pdfOf(['First page', '', 'Third page']), 'PDF')

    expect(await written()).toEqual([
      { loc: { page: 1 }, text: expect.stringContaining('First page') },
      { loc: { page: 2 }, text: '', unreadable: 'no-text' },
      { loc: { page: 3 }, text: expect.stringContaining('Third page') },
    ])
    const text = result!.documentText!
    expect(text.key).toMatch(KEY_RE('text\\.ndjson\\.zst'))
    expect(text.bytes).toBeGreaterThan(0)
    // The head the suggestion and the abstract read is cut from the artifact
    expect(capture.uploads.size).toBe(1)
    // Nothing a text format would carry
    expect(result!.previewKey).toBeNull()
    expect(result!.encoding).toBeUndefined()
  })

  it('reads the version it was given, not the resource as it stands', async () => {
    await interpret(await pdfOf(['text']), 'PDF')
    expect(ctx.storage.download).toHaveBeenCalledWith('v1')
  })

  it('keeps the pages of a document with no text, saying it has none', async () => {
    const result = await interpret(await pdfOf(['', '']), 'PDF')

    expect((await written()).map((b) => b.unreadable)).toEqual(['no-text', 'no-text'])
    expect(result!.documentText!.bytes).toBe(0)
  })

  it('reads a workbook by sheet, each line a row', async () => {
    const workbook = await xlsxBuffer({
      shared: ['<si><t>地域</t></si>', '<si><t>人口</t></si>'],
      sheets: {
        1: [
          [{ s: 0 }, { s: 1 }],
          [{ inline: '東京' }, 14000000],
        ],
      },
      tabs: [1],
    })

    const result = await interpret(workbook, 'XLSX')

    expect(await written()).toEqual([
      { loc: { sheet: 1, sheetName: 's1', rows: [1, 2] }, text: '地域\t人口\n東京\t14000000' },
    ])
    expect(result!.documentText!.bytes).toBe(Buffer.byteLength('地域\t人口\n東京\t14000000'))
  })

  it('reads a Markdown file under its headings, and says its encoding as text would', async () => {
    const result = await interpret(Buffer.from('# 利用規約\n\n- **第 1 条** 本文\n'), 'MD')

    expect(await written()).toEqual([
      { loc: {}, headings: ['利用規約'], text: '# 利用規約\n\n- **第 1 条** 本文' },
    ])
    expect(result!.documentText!.bytes).toBe(Buffer.byteLength('# 利用規約\n\n- **第 1 条** 本文'))
    // The raw text preview still decodes it, by convention UTF-8
    expect(result!.encoding).toBe('UTF8')
    expect(result!.previewKey).toBeNull()
  })

  it('reads a workbook of the format before 2007 as a workbook of the one after', async () => {
    const workbook = xlsBuffer({
      sheets: [{ name: '人口', cells: [cell.label(0, 0, '東京'), cell.number(0, 1, 14000000)] }],
    })

    await interpret(workbook, 'XLS')

    expect(await written()).toEqual([
      { loc: { sheet: 1, sheetName: '人口', rows: [1] }, text: '東京\t14000000' },
    ])
  })

  it('reads a workbook saved as XLSX and published as .xls as an XLSX', async () => {
    const workbook = await xlsxBuffer({ sheets: { 1: [[1, 2]] } })

    await interpret(workbook, 'XLS')

    expect(await written()).toEqual([{ loc: { sheet: 1, rows: [1] }, text: '1\t2' }])
  })

  it('fails, keeping nothing, on a file its parser cannot read', async () => {
    await expect(interpret(Buffer.from('not a pdf'), 'PDF')).rejects.toThrow()
    expect(ctx.putObject).not.toHaveBeenCalled()
  })
})
