import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ResourcePreview } from '../resource-preview'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

// Neither view is reached here; mocked so Leaflet, hyparquet and DuckDB-WASM
// stay out of the test
vi.mock('../geojson-preview', () => ({ GeoJsonPreview: () => null }))
vi.mock('@/components/data-explorer/data-explorer', () => ({ DataExplorer: () => null }))
vi.mock('../document-text-preview', () => ({
  DocumentTextPreview: ({ resourceId }: { resourceId: string }) => (
    <div data-testid="document-text-preview">Extracted text of {resourceId}</div>
  ),
}))

import { clientFetch } from '@/lib/client-api'

const mockClientFetch = vi.mocked(clientFetch)

beforeEach(() => {
  mockClientFetch.mockReset()
})

/** What `GET /resources/:id/text` answers for a Markdown file. */
function textResponse(markdown: string, truncated = false) {
  mockClientFetch.mockResolvedValueOnce({
    ok: true,
    headers: new Headers({
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Detected-Encoding': 'UTF-8',
      'X-Truncated': truncated ? 'true' : 'false',
    }),
    arrayBuffer: async () => new TextEncoder().encode(markdown).buffer,
  } as Response)
}

const DOCUMENT = [
  '# Terms of use',
  '',
  'Some **bold** text and a [link](https://example.com/terms).',
  '',
  '- first item',
  '- second item',
  '',
  '| Column | Type |',
  '| ------ | ---- |',
  '| id     | int  |',
].join('\n')

describe('Markdown preview', () => {
  it('draws headings, lists, tables and links from the file', async () => {
    textResponse(DOCUMENT)
    render(<ResourcePreview resourceId="r1" format="MD" />)

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Terms of use' })).toBeInTheDocument()
    )
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'first item',
      'second item',
    ])
    expect(screen.getByRole('columnheader', { name: 'Column' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'int' })).toBeInTheDocument()

    const link = screen.getByRole('link', { name: 'link' })
    expect(link).toHaveAttribute('href', 'https://example.com/terms')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('switches to the source of the file, which is the Markdown as written', async () => {
    textResponse(DOCUMENT)
    render(<ResourcePreview resourceId="r1" format="MD" />)
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument())

    fireEvent.click(screen.getByText('Source'))

    expect(screen.getByRole('heading', { level: 1, hidden: true })).not.toBeVisible()
    expect(screen.getByText(/# Terms of use/)).toBeVisible()
    // One read serves both views, and each stays drawn once shown
    expect(mockClientFetch).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('Formatted'))
    expect(screen.getByRole('heading', { level: 1 })).toBeVisible()
    expect(screen.getByText(/# Terms of use/)).not.toBeVisible()
  })

  it('shows the text extracted from the file, under its headings, once asked for', async () => {
    textResponse(DOCUMENT)
    render(<ResourcePreview resourceId="r1" format="MD" />)
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument())
    expect(screen.queryByTestId('document-text-preview')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Extracted text'))

    expect(screen.getByTestId('document-text-preview')).toBeVisible()
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
  })

  it('draws no HTML the file writes, only the text between its tags', async () => {
    textResponse('<script>alert(1)</script>\n\nA <b>bold</b> word <img src=x onerror=alert(1)>\n')
    const { container } = render(<ResourcePreview resourceId="r1" format="MD" />)

    await waitFor(() => expect(screen.getByText(/A bold word/)).toBeInTheDocument())
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).not.toContain('alert')
  })

  it('shows an image as its alternative text, not as an image', async () => {
    textResponse('![Figure 1: the map](./fig1.png)\n')
    const { container } = render(<ResourcePreview resourceId="r1" format="MD" />)

    await waitFor(() => expect(screen.getByText('Figure 1: the map')).toBeInTheDocument())
    expect(container.querySelector('img')).toBeNull()
  })

  it("gives a link outside the allowlist, or into the file's own site, no href", async () => {
    textResponse(
      '[click](javascript:alert(1)) and [mail](mailto:a@example.com) and [next](./b.md) and [top](#intro)\n'
    )
    const { container } = render(<ResourcePreview resourceId="r1" format="MD" />)

    await waitFor(() =>
      expect(container.querySelector('p')).toHaveTextContent('click and mail and next and top')
    )
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['mail'])
    expect(screen.getByRole('link', { name: 'mail' })).toHaveAttribute(
      'href',
      'mailto:a@example.com'
    )
  })

  it('says the file was cut at the preview limit, as the text view does', async () => {
    textResponse('# Big\n', true)
    render(<ResourcePreview resourceId="r1" format="MD" />)

    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument())
    expect(screen.getByText(/showing first 1 MB only/)).toBeInTheDocument()
  })
})
