import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { JsonPreview, highlightJson } from '../json-preview'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

import { clientFetch } from '@/lib/client-api'

const mockClientFetch = vi.mocked(clientFetch)

beforeEach(() => {
  mockClientFetch.mockReset()
})

describe('highlightJson', () => {
  it('colours each kind of token and keeps the text between them', () => {
    const json = '{"name": "Tokyo", "pop": -1.4e7, "capital": true, "note": null}'
    const { container } = render(<pre>{highlightJson(json)}</pre>)

    expect(container.textContent).toBe(json)
    const spans = [...container.querySelectorAll('span')].map((s) => [
      s.textContent,
      s.className.split(' ')[0],
    ])
    expect(spans).toEqual([
      ['"name"', 'text-sky-600'],
      ['"Tokyo"', 'text-emerald-600'],
      ['"pop"', 'text-sky-600'],
      ['-1.4e7', 'text-amber-600'],
      ['"capital"', 'text-sky-600'],
      ['true', 'text-violet-600'],
      ['"note"', 'text-sky-600'],
      ['null', 'text-violet-600'],
    ])
  })

  it('treats an escaped quote as part of the string, not its end', () => {
    const json = '"say \\"hi\\""'
    const { container } = render(<pre>{highlightJson(json)}</pre>)
    expect(container.querySelectorAll('span')).toHaveLength(1)
    expect(container.querySelector('span')).toHaveTextContent('"say \\"hi\\""')
  })
})

describe('JsonPreview', () => {
  it('fetches the resource’s JSON by its encoded id and shows it indented', async () => {
    mockClientFetch.mockResolvedValue(Response.json({ a: [1, 2] }))
    const { container } = render(<JsonPreview resourceId="r/1" />)

    expect(await screen.findByText('"a"')).toBeInTheDocument()
    expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/resources/r%2F1/json')
    expect(container.querySelector('pre')!.textContent).toBe(JSON.stringify({ a: [1, 2] }, null, 2))
  })

  it('says the file is too large when the API answers 413', async () => {
    mockClientFetch.mockResolvedValue(new Response(null, { status: 413 }))
    render(<JsonPreview resourceId="r1" />)
    expect(await screen.findByText(/too large for JSON preview/)).toBeInTheDocument()
  })

  it.each([
    [
      'another error status',
      () => mockClientFetch.mockResolvedValue(new Response(null, { status: 500 })),
    ],
    ['a failed request', () => mockClientFetch.mockRejectedValue(new Error('offline'))],
  ])('shows the generic preview error on %s', async (_label, arrange) => {
    arrange()
    render(<JsonPreview resourceId="r1" />)
    expect(await screen.findByText('Failed to load preview')).toBeInTheDocument()
  })
})
