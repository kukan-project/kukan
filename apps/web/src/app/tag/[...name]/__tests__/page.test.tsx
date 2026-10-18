import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { notFound } from 'next/navigation'
import { serverFetch } from '@/lib/server-api'
import TagDatasetsPage from '../page'

vi.mock('@/lib/server-api', () => ({
  serverFetch: vi.fn(),
}))

function mockResponse(data: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => data } as Response
}

const sampleDatasets = [
  { id: 'pkg-1', name: 'evacuation-sites', title: 'Evacuation Sites', notes: null },
  { id: 'pkg-2', name: 'shelters', title: 'Shelters', notes: null },
]

function makeProps(name: string[], searchParams: Record<string, string> = {}) {
  return { params: Promise.resolve({ name }), searchParams: Promise.resolve(searchParams) }
}

function requested() {
  const url = vi.mocked(serverFetch).mock.calls[0][0] as string
  expect(url).toMatch(/^\/api\/v1\/packages\?/)
  return new URLSearchParams(url.split('?')[1])
}

describe('TagDatasetsPage', () => {
  beforeEach(() => {
    vi.mocked(serverFetch).mockReset()
    vi.mocked(notFound).mockClear()
  })

  it('should list the datasets carrying the tag, under a breadcrumb to the datasets', async () => {
    vi.mocked(serverFetch).mockResolvedValueOnce(
      mockResponse({ items: sampleDatasets, total: 2, offset: 0, limit: 20 })
    )
    render(await TagDatasetsPage(makeProps(['disaster'])))

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Tag: disaster')
    expect(screen.getByText('Datasets').closest('a')).toHaveAttribute('href', '/dataset')
    expect(screen.getByText('2 datasets')).toBeInTheDocument()
    expect(screen.getByText('Evacuation Sites')).toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
  })

  it('should search as /dataset?tags= does, passing the page along', async () => {
    vi.mocked(serverFetch).mockResolvedValueOnce(
      mockResponse({ items: sampleDatasets, total: 60, offset: 20, limit: 20 })
    )
    render(await TagDatasetsPage(makeProps(['disaster'], { offset: '20' })))

    expect(requested().get('tags')).toBe('disaster')
    expect(requested().get('offset')).toBe('20')
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
  })

  it('should decode the segments, reading a slash in the name either way', async () => {
    for (const segments of [
      ['%E9%98%B2%E7%81%BD%2F%E9%81%BF%E9%9B%A3'],
      ['%E9%98%B2%E7%81%BD', '%E9%81%BF%E9%9B%A3'],
    ]) {
      vi.mocked(serverFetch).mockResolvedValueOnce(
        mockResponse({ items: sampleDatasets, total: 2, offset: 0, limit: 20 })
      )
      await TagDatasetsPage(makeProps(segments))
      expect(requested().get('tags')).toBe('防災/避難')
      vi.mocked(serverFetch).mockClear()
    }
  })

  it('should call notFound when no visible dataset carries the tag', async () => {
    vi.mocked(serverFetch).mockResolvedValueOnce(
      mockResponse({ items: [], total: 0, offset: 0, limit: 20 })
    )

    await expect(TagDatasetsPage(makeProps(['no-such-tag']))).rejects.toThrow('NEXT_NOT_FOUND')
    expect(notFound).toHaveBeenCalled()
  })

  it('should call notFound for a segment that does not decode', async () => {
    await expect(TagDatasetsPage(makeProps(['%E0%A4%A']))).rejects.toThrow('NEXT_NOT_FOUND')
    expect(serverFetch).not.toHaveBeenCalled()
  })

  it('should throw, not call notFound, when the API fails', async () => {
    vi.mocked(serverFetch).mockResolvedValueOnce(mockResponse(null, 500))

    await expect(TagDatasetsPage(makeProps(['disaster']))).rejects.toThrow('failed with 500')
    expect(notFound).not.toHaveBeenCalled()
  })
})
