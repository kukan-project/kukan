import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import type { DocumentTextBlock } from '@kukan/shared'
import type { StorageAdapter } from '@kukan/storage-adapter'
import {
  readDocumentOutline,
  readDocumentSection,
  type SectionPosition,
  type SectionQuery,
} from '../../services/document-text'
import { artifactOf } from '../test-helpers/document-text'

function storageOf(lines: (DocumentTextBlock | string)[]): StorageAdapter {
  const artifact = artifactOf(lines)
  return { download: async () => Readable.from([artifact]) } as unknown as StorageAdapter
}

const limits = { maxChars: 8000, maxBlocks: 100 }
const origin: SectionPosition = { block: 0, offset: 0 }

async function section(
  blocks: (DocumentTextBlock | string)[],
  query: SectionQuery,
  start = origin,
  opts = limits
) {
  return readDocumentSection(storageOf(blocks), 'k', query, start, opts)
}

const report: DocumentTextBlock[] = [
  { loc: { page: 1 }, headings: ['はじめに'], text: '目的' },
  { loc: { page: 2 }, headings: ['第１章　概要'], text: '概要の本文' },
  { loc: { page: 2 }, text: '地図', figure: { ref: '9 0 R' } },
  { loc: { page: 3 }, headings: ['第１章　概要', '1.1 背景'], text: '背景の本文' },
  { loc: { page: 4 }, text: '', unreadable: 'no-text' },
  { loc: { page: 4 }, text: '', figure: { ref: '12 0 R' } },
]

describe('readDocumentSection', () => {
  it('selects the pages in the range, and figures with a description', async () => {
    const { parts, next, unmatched } = await section(report, { from: 2, to: 3 })

    expect(parts.map((p) => p.text)).toEqual(['概要の本文', '地図', '背景の本文'])
    expect(next).toBeNull()
    expect(unmatched).toBeUndefined()
  })

  it('keeps a page with no text, which says why, and leaves out a figure with nothing to read', async () => {
    const { parts } = await section(report, { from: 4 })

    expect(parts).toEqual([{ block: report[4], text: '', offset: 0 }])
  })

  it('matches a heading as typed, whatever its width, case and spaces', async () => {
    const { parts } = await section(report, { heading: '第1章概要' })

    // The heading path holds it, so the subsection under it is in it too
    expect(parts.map((p) => p.text)).toEqual(['概要の本文', '背景の本文'])
  })

  it("matches a sheet's name, and takes both the range and the heading where given", async () => {
    const book: DocumentTextBlock[] = [
      { loc: { sheet: 1, sheetName: 'Summary', rows: [1] }, text: 'a' },
      { loc: { sheet: 2, sheetName: 'Data 2024', rows: [1, 2] }, text: 'b\nc' },
      { loc: { sheet: 3, sheetName: 'Data 2025', rows: [1] }, text: 'd' },
    ]

    expect((await section(book, { heading: 'data' })).parts.map((p) => p.text)).toEqual([
      'b\nc',
      'd',
    ])
    expect((await section(book, { heading: 'data', to: 2 })).parts.map((p) => p.text)).toEqual([
      'b\nc',
    ])
  })

  it('selects nothing by page in a document that has none', async () => {
    const docx: DocumentTextBlock[] = [{ loc: {}, headings: ['見出し'], text: '本文' }]

    const { parts, unmatched } = await section(docx, { from: 1 })

    expect(parts).toEqual([])
    expect(unmatched).toEqual({ units: null })
  })

  it('matches a path of headings, picking one under another', async () => {
    const { parts } = await section(report, { heading: '第1章 概要 > 1.1 背景' })

    expect(parts.map((p) => p.text)).toEqual(['背景の本文'])
  })

  it('reads a range up to its end and no further', async () => {
    // A line past the range that would fail the read if it were parsed
    const blocks = [{ loc: { page: 1 }, text: 'one' }, { loc: { page: 2 }, text: 'two' }, '{broken']

    const { parts, next } = await section(blocks, { to: 1 })

    expect(parts.map((p) => p.text)).toEqual(['one'])
    expect(next).toBeNull()
  })

  it('reads on from a cursor without parsing the blocks before it', async () => {
    const blocks = ['{broken', { loc: { page: 2 }, text: 'two' }]

    const { parts } = await section(blocks, {}, { block: 1, offset: 0 })

    expect(parts.map((p) => p.text)).toEqual(['two'])
  })

  it('answers no match with the range of pages to ask again in', async () => {
    const { parts, unmatched } = await section(report, { heading: '付録' })

    expect(parts).toEqual([])
    expect(unmatched).toEqual({ units: { min: 1, max: 4 } })
  })

  it('cuts a block at a line break and resumes where it stopped, losing nothing', async () => {
    const text = Array.from({ length: 10 }, (_, i) => `${i}行目の文`).join('\n')
    const blocks: DocumentTextBlock[] = [
      { loc: { page: 1 }, text },
      { loc: { page: 2 }, text: '次の頁' },
    ]
    const opts = { ...limits, maxChars: 20 }

    const read: string[] = []
    let start = origin
    for (let call = 0; call < 10; call++) {
      const { parts, next } = await section(blocks, {}, start, opts)
      for (const part of parts) {
        expect(part.text.length).toBeLessThanOrEqual(20)
        expect(part.offset > 0).toBe(part.block.loc.page === 1 && read.length > 0)
        read.push(part.text)
      }
      if (!next) break
      start = next
    }

    // Each cut is after a line, and the pieces are the whole text again
    expect(read).toHaveLength(5)
    expect(read.slice(0, 3).every((t) => t.endsWith('\n'))).toBe(true)
    expect(read.join('')).toBe(text + '次の頁')
  })

  it('says where the next block starts when the limit falls between blocks', async () => {
    const blocks: DocumentTextBlock[] = [
      { loc: { page: 1 }, text: 'abcd' },
      { loc: { page: 2 }, text: 'skipped' },
      { loc: { page: 3 }, text: 'efgh' },
    ]

    const first = await section(blocks, { heading: '' }, origin, { ...limits, maxChars: 4 })
    expect(first.parts.map((p) => p.text)).toEqual(['abcd'])
    expect(first.next).toEqual({ block: 1, offset: 0 })

    // Past the last block the range selects, there is nothing more
    const ranged = await section(blocks, { to: 1 }, origin, { ...limits, maxChars: 4 })
    expect(ranged.next).toBeNull()
  })

  it('stops after so many blocks, so a run of scanned pages is paged too', async () => {
    const scans: DocumentTextBlock[] = Array.from({ length: 5 }, (_, i) => ({
      loc: { page: i + 1 },
      text: '',
      unreadable: 'no-text' as const,
    }))

    const { parts, next } = await section(scans, {}, origin, { ...limits, maxBlocks: 2 })

    expect(parts).toHaveLength(2)
    expect(next).toEqual({ block: 2, offset: 0 })
  })

  it('reads on from a cursor past the blocks it matched, without calling it no match', async () => {
    const { parts, unmatched, next } = await section(
      report,
      { from: 2, to: 2 },
      { block: 2, offset: 0 }
    )

    expect(parts.map((p) => p.text)).toEqual(['地図'])
    expect(unmatched).toBeUndefined()
    expect(next).toBeNull()
  })

  it('never splits a character in two, even at a limit of one', async () => {
    const blocks: DocumentTextBlock[] = [{ loc: { page: 1 }, text: '𠮷野家' }]

    const { parts, next } = await section(blocks, {}, origin, { ...limits, maxChars: 1 })

    expect(parts[0]!.text).toBe('𠮷')
    expect(next).toEqual({ block: 0, offset: 2 })
  })
})

describe('readDocumentOutline', () => {
  const outlineOf = (
    lines: (DocumentTextBlock | string)[],
    range: { from?: number; to?: number } = {}
  ) => readDocumentOutline(storageOf(lines), 'k', range)

  it('lists each heading once, nested, with the pages it spans', async () => {
    // As the worker writes them: a figure and a scanned page carry their page's headings
    const plan: DocumentTextBlock[] = [
      { loc: { page: 1 }, text: '表紙' },
      { loc: { page: 2 }, headings: ['第1章'], text: 'a' },
      { loc: { page: 3 }, headings: ['第1章', '1.1 背景'], text: 'b' },
      { loc: { page: 3 }, headings: ['第1章', '1.1 背景'], text: '', figure: { ref: '9 0 R' } },
      { loc: { page: 4 }, headings: ['第1章', '1.1 背景'], text: 'c' },
      { loc: { page: 5 }, headings: ['第1章', '1.2 課題'], text: 'd' },
      { loc: { page: 6 }, headings: ['第1章', '1.2 課題'], text: '', unreadable: 'no-text' },
      { loc: { page: 7 }, headings: ['第2章'], text: 'e', unreadable: 'unmapped-fonts' },
    ]

    expect(await outlineOf(plan)).toEqual({
      units: { kind: 'page', min: 1, max: 7 },
      entries: [
        { depth: 0, title: '第1章', units: { min: 2, max: 6 } },
        { depth: 1, title: '1.1 背景', units: { min: 3, max: 4 } },
        { depth: 1, title: '1.2 課題', units: { min: 5, max: 6 } },
        { depth: 0, title: '第2章', units: { min: 7, max: 7 } },
      ],
      unreadable: [{ min: 6, max: 7 }],
    })
  })

  it('ends a heading at an untitled slide, as reading by that heading does', async () => {
    const deck: DocumentTextBlock[] = [
      { loc: { slide: 1 }, headings: ['はじめに'], text: 'a' },
      { loc: { slide: 2 }, text: '写真' },
      { loc: { slide: 3 }, headings: ['まとめ'], text: 'b' },
    ]

    const { entries } = await outlineOf(deck)
    const { parts } = await section(deck, { heading: 'はじめに' })

    expect(entries[0]).toEqual({ depth: 0, title: 'はじめに', units: { min: 1, max: 1 } })
    expect(parts.map((p) => p.block.loc.slide)).toEqual([1])
  })

  it("stands a workbook's sheets in for headings, by name or number, with their rows", async () => {
    const book: DocumentTextBlock[] = [
      { loc: { sheet: 1, sheetName: '集計', rows: [1, 2] }, text: 'a\nb' },
      { loc: { sheet: 1, sheetName: '集計', rows: [4, 9] }, text: 'c\nd' },
      { loc: { sheet: 2, rows: [1] }, text: 'e' },
    ]

    const { units, entries } = await outlineOf(book)

    expect(units).toEqual({ kind: 'sheet', min: 1, max: 2 })
    expect(entries).toEqual([
      { depth: 0, title: '集計', units: { min: 1, max: 1 }, rows: { min: 1, max: 9 } },
      { depth: 0, title: 'sheet 2', units: { min: 2, max: 2 }, rows: { min: 1, max: 1 } },
    ])
    // The title an unnamed sheet is listed under reads it
    expect((await section(book, { heading: 'sheet 2' })).parts.map((p) => p.text)).toEqual(['e'])
  })

  it('reads only the range asked for', async () => {
    const pages = Array.from({ length: 3 }, (_, i) => ({
      loc: { page: i + 1 },
      headings: [`章${i + 1}`],
      text: 'x',
    }))

    // A line past the range that would fail the read if it were parsed
    const ranged = await outlineOf([...pages, '{broken'], { from: 2, to: 2 })

    expect(ranged.units).toEqual({ kind: 'page', min: 2, max: 2 })
    expect(ranged.entries.map((e) => e.title)).toEqual(['章2'])
    expect((await outlineOf(pages, { from: 9 })).units).toBeNull()
  })

  it('gives a document without pages its headings alone', async () => {
    const docx: DocumentTextBlock[] = [
      { loc: {}, headings: ['はじめに'], text: 'a' },
      { loc: {}, headings: ['はじめに', '目的'], text: 'b' },
    ]

    expect(await outlineOf(docx)).toEqual({
      units: null,
      entries: [
        { depth: 0, title: 'はじめに' },
        { depth: 1, title: '目的' },
      ],
      unreadable: [],
    })
  })
})
