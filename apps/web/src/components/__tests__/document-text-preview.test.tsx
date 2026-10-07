import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { DocumentText } from '@kukan/shared'
import { ResourcePreview } from '../resource-preview'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

import { clientFetch } from '@/lib/client-api'

const mockClientFetch = vi.mocked(clientFetch)

beforeEach(() => {
  mockClientFetch.mockReset()
})

/** The PDF's own preview answers its HEAD; the extracted text answers with `text`. */
function serve(text: DocumentText | null) {
  mockClientFetch.mockImplementation(async (path: string) => {
    if (path.endsWith('/document-text')) {
      return text ? Response.json(text) : new Response(null, { status: 404 })
    }
    return new Response(null, { status: 200 })
  })
}

async function showText(format = 'PDF') {
  render(<ResourcePreview resourceId="r1" format={format} />)
  fireEvent.click(await screen.findByText('Extracted text'))
}

describe('extracted text preview', () => {
  it('shows the original first, the text on asking', async () => {
    serve({ blocks: [{ loc: { page: 1 }, text: 'body' }], truncated: false })
    render(<ResourcePreview resourceId="r1" format="PDF" />)

    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull())
    fireEvent.click(screen.getByText('Extracted text'))

    expect(await screen.findByText('body')).toBeInTheDocument()
    expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/resources/r1/document-text')
  })

  it('reads a page at a time, saying where the PDF prints a number of its own', async () => {
    serve({
      blocks: [
        { loc: { page: 1, label: 'i' }, text: 'cover' },
        { loc: { page: 2 }, text: '', unreadable: 'no-text' },
      ],
      truncated: false,
    })
    await showText()

    expect(await screen.findByRole('heading', { name: /p\. 1 \(printed i\)/ })).toBeInTheDocument()
    expect(screen.getByText('This page has no text (images only, or a scan)')).toBeInTheDocument()
    // With no headings in the file, the pages are the outline
    expect(screen.getByRole('navigation', { name: 'Pages' })).toBeInTheDocument()
  })

  it('says a page in fonts it cannot be read from is so, once a page, with what it has', async () => {
    serve({
      blocks: [
        // One long page, written as two blocks
        { loc: { page: 1 }, text: '10', unreadable: 'unmapped-fonts' },
        { loc: { page: 1 }, text: '11', unreadable: 'unmapped-fonts' },
        { loc: { page: 2 }, text: 'body' },
      ],
      truncated: false,
    })
    await showText()

    expect(await screen.findByText(/· unreadable pages: 1$/)).toBeInTheDocument()
    expect(screen.getAllByText(/Most of this page's text cannot be read/)).toHaveLength(2)
    expect(screen.getByText('10')).toBeInTheDocument()
  })

  it('numbers each line of a sheet with its row, and the sheet by name or number', async () => {
    serve({
      blocks: [
        {
          loc: { sheet: 1, sheetName: '4月度', rows: [2, 5] },
          text: '期間\t内容\n1～30\t机・イス',
        },
        { loc: { sheet: 2, rows: [1] }, text: '合計' },
      ],
      truncated: false,
    })
    await showText()

    expect(await screen.findByRole('heading', { name: 'Sheet "4月度"' })).toBeInTheDocument()
    // A workbook's outline is its sheets, not pages
    expect(screen.getByRole('navigation', { name: 'Sheets' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Sheet 2' })).toBeInTheDocument()
    // The empty rows between are skipped, and the numbers say so
    // Matched as Testing Library normalises it, the tab a space
    const row = screen.getByText('1～30 机・イス').parentElement!
    expect(row.textContent).toBe('51～30\t机・イス')
  })

  it('outlines the headings, each where it first appears', async () => {
    serve({
      blocks: [
        { loc: { page: 1 }, headings: ['第1章'], text: 'a' },
        { loc: { page: 2 }, headings: ['第1章', '1.1 目的'], text: 'b' },
        { loc: { page: 3 }, headings: ['第1章', '1.1 目的'], text: 'c' },
      ],
      truncated: false,
    })
    await showText()

    const outline = await screen.findByRole('navigation', { name: 'Headings' })
    expect(Array.from(outline.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      '第1章',
      '1.1 目的',
    ])
  })

  it('shows a figure by its size and how often the picture recurs', async () => {
    const figure = { ref: '3 0 R', width: 153, height: 285, digest: 'dc6e' }
    serve({
      blocks: [
        { loc: { page: 1 }, text: 'a' },
        { loc: { page: 1 }, text: '', figure },
        { loc: { page: 2 }, text: '', figure: { ...figure, ref: '8 0 R' } },
      ],
      truncated: false,
    })
    await showText()

    expect(
      await screen.findByText('Figure · 153×285 px · 3 0 R · same image in 2 places')
    ).toBeInTheDocument()
  })

  it('says there is no text yet for a document without it', async () => {
    serve(null)
    await showText()

    expect(await screen.findByText(/No extracted text yet/)).toBeInTheDocument()
  })

  it('shows the text alone for a format the browser cannot show', async () => {
    serve({ blocks: [{ loc: {}, text: 'odt body' }], truncated: false })
    render(<ResourcePreview resourceId="r1" format="ODT" />)

    expect(await screen.findByText('odt body')).toBeInTheDocument()
    expect(screen.queryByText('Original')).toBeNull()
  })
})
