import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { serverFetch } from '@/lib/server-api'
import GroupsPage from '../page'

vi.mock('@/lib/server-api', () => ({
  serverFetch: vi.fn(),
}))

function mockResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

const sampleGroups = [
  {
    id: 'g1',
    name: 'demographics',
    title: 'Demographics',
    description: 'Population and demographics data.',
    imageUrl: null,
    datasetCount: 12,
  },
  {
    id: 'g2',
    name: 'environment',
    title: 'Environment',
    description: null,
    imageUrl: 'https://example.com/env.png',
    datasetCount: 5,
  },
]

function makeSearchParams(params: Record<string, string> = {}) {
  return { searchParams: Promise.resolve(params) }
}

describe('GroupsPage', () => {
  beforeEach(() => {
    vi.mocked(serverFetch).mockReset()
  })

  it('should display group cards with title and dataset count', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: sampleGroups, total: 2, offset: 0, limit: 20 })
    )
    const jsx = await GroupsPage(makeSearchParams())
    render(jsx)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Categories')
    expect(screen.getByText('2 items')).toBeInTheDocument()
    expect(screen.getByText('Demographics')).toBeInTheDocument()
    expect(screen.getByText('Environment')).toBeInTheDocument()
    expect(screen.getByText('12 datasets')).toBeInTheDocument()
    expect(screen.getByText('5 datasets')).toBeInTheDocument()
  })

  it('should show group description when available', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: sampleGroups, total: 2, offset: 0, limit: 20 })
    )
    const jsx = await GroupsPage(makeSearchParams())
    render(jsx)

    expect(screen.getByText('Population and demographics data.')).toBeInTheDocument()
  })

  it('should link group cards to detail page', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: sampleGroups, total: 2, offset: 0, limit: 20 })
    )
    const jsx = await GroupsPage(makeSearchParams())
    render(jsx)

    const link = screen.getByText('Demographics').closest('a')
    expect(link).toHaveAttribute('href', '/group/demographics')
  })

  it('should show empty state when no groups', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: [], total: 0, offset: 0, limit: 20 })
    )
    const jsx = await GroupsPage(makeSearchParams())
    render(jsx)

    expect(screen.getByText('No categories')).toBeInTheDocument()
  })

  it('should show no-match message when query has no results', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: [], total: 0, offset: 0, limit: 20 })
    )
    const jsx = await GroupsPage(makeSearchParams({ q: 'nonexistent' }))
    render(jsx)

    expect(screen.getByText('No categories matching "nonexistent"')).toBeInTheDocument()
  })

  it('should pass query parameters to API', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: [], total: 0, offset: 0, limit: 20 })
    )
    await GroupsPage(makeSearchParams({ q: 'demo', offset: '20' }))

    expect(serverFetch).toHaveBeenCalledTimes(1)
    const url = vi.mocked(serverFetch).mock.calls[0][0] as string
    expect(url).toContain('q=demo')
    expect(url).toContain('offset=20')
  })

  it('should show pagination when total exceeds limit', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: sampleGroups, total: 60, offset: 0, limit: 20 })
    )
    const jsx = await GroupsPage(makeSearchParams())
    render(jsx)

    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    expect(screen.getByText('Next')).toBeInTheDocument()
  })

  it('should not show pagination when total fits in one page', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: sampleGroups, total: 2, offset: 0, limit: 20 })
    )
    const jsx = await GroupsPage(makeSearchParams())
    render(jsx)

    expect(screen.queryByText('Next')).not.toBeInTheDocument()
  })

  it('should handle API failure gracefully', async () => {
    vi.mocked(serverFetch).mockRejectedValue(new Error('API down'))
    const jsx = await GroupsPage(makeSearchParams())
    render(jsx)

    expect(screen.getByText('No categories')).toBeInTheDocument()
    expect(screen.getByText('0 items')).toBeInTheDocument()
  })

  it('should use name as fallback when title is null', async () => {
    const groupNoTitle = [{ ...sampleGroups[0], title: null }]
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: groupNoTitle, total: 1, offset: 0, limit: 20 })
    )
    const jsx = await GroupsPage(makeSearchParams())
    render(jsx)

    expect(screen.getByText('demographics')).toBeInTheDocument()
  })
})
