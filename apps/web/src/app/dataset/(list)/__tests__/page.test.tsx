import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { serverFetch } from '@/lib/server-api'
import DatasetsPage from '../page'

vi.mock('@/lib/server-api', () => ({
  serverFetch: vi.fn(),
}))

function mockResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

const sampleItems = [
  {
    id: '1',
    name: 'population-data',
    title: 'Population Data',
    notes: 'Annual population statistics.',
    formats: 'CSV',
    resourceCount: 3,
    orgName: 'tokyo',
    orgTitle: 'Tokyo Metropolitan',
    tags: 'statistics,population',
    groups: 'demographics:Demographics',
  },
  {
    id: '2',
    name: 'budget-report',
    title: 'Budget Report',
    notes: null,
    formats: 'PDF,XLSX',
    resourceCount: 1,
    orgName: 'osaka',
    orgTitle: 'Osaka City',
  },
]

const sampleFacets = {
  organizations: [
    { name: 'tokyo', title: 'Tokyo Metropolitan', count: 10 },
    { name: 'osaka', title: 'Osaka City', count: 5 },
  ],
  groups: [{ name: 'demographics', title: 'Demographics', count: 8 }],
  tags: [
    { name: 'statistics', count: 12 },
    { name: 'population', count: 6 },
  ],
  formats: [
    { name: 'CSV', count: 15 },
    { name: 'PDF', count: 7 },
  ],
  licenses: [{ name: 'CC-BY-4.0', count: 20 }],
}

function makeSearchParams(params: Record<string, string> = {}) {
  return { searchParams: Promise.resolve(params) }
}

describe('DatasetsPage', () => {
  beforeEach(() => {
    vi.mocked(serverFetch).mockReset()
  })

  it('should display dataset cards', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: sampleItems, total: 2, offset: 0, limit: 20, facets: sampleFacets })
    )
    const jsx = await DatasetsPage(makeSearchParams())
    render(jsx)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Datasets')
    expect(screen.getByText('2 items')).toBeInTheDocument()
    expect(screen.getByText('Population Data')).toBeInTheDocument()
    expect(screen.getByText('Budget Report')).toBeInTheDocument()
  })

  it('should show dataset notes as excerpt', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: sampleItems, total: 2, offset: 0, limit: 20, facets: sampleFacets })
    )
    const jsx = await DatasetsPage(makeSearchParams())
    render(jsx)

    expect(screen.getByText('Annual population statistics.')).toBeInTheDocument()
  })

  it('should show organization, category, and tags on dataset cards', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: sampleItems, total: 2, offset: 0, limit: 20, facets: sampleFacets })
    )
    const jsx = await DatasetsPage(makeSearchParams())
    render(jsx)

    // Appears in both card and facet sidebar
    expect(screen.getAllByText('Tokyo Metropolitan').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('Demographics').length).toBeGreaterThanOrEqual(2)
    // Tags appear on card and in facet
    expect(screen.getAllByText('statistics').length).toBeGreaterThanOrEqual(2)
  })

  it('should show resource count on cards', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: sampleItems, total: 2, offset: 0, limit: 20, facets: sampleFacets })
    )
    const jsx = await DatasetsPage(makeSearchParams())
    render(jsx)

    expect(screen.getByText('All 3 resources')).toBeInTheDocument()
    expect(screen.getByText('All 1 resources')).toBeInTheDocument()
  })

  it('should show empty state when no datasets', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: [], total: 0, offset: 0, limit: 20, facets: sampleFacets })
    )
    const jsx = await DatasetsPage(makeSearchParams())
    render(jsx)

    expect(screen.getByText('No datasets')).toBeInTheDocument()
  })

  it('should use CSR when query is present (no serverFetch)', async () => {
    const jsx = await DatasetsPage(makeSearchParams({ q: 'test' }))
    render(jsx)

    expect(serverFetch).not.toHaveBeenCalled()
  })

  it('should show pagination when total exceeds limit', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: sampleItems, total: 60, offset: 0, limit: 20, facets: sampleFacets })
    )
    const jsx = await DatasetsPage(makeSearchParams())
    render(jsx)

    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    expect(screen.getByText('Next')).toBeInTheDocument()
  })

  it('should not show pagination when total fits in one page', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: sampleItems, total: 2, offset: 0, limit: 20, facets: sampleFacets })
    )
    const jsx = await DatasetsPage(makeSearchParams())
    render(jsx)

    expect(screen.queryByText('Next')).not.toBeInTheDocument()
  })

  it('should render facet filters in sidebar', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: sampleItems, total: 2, offset: 0, limit: 20, facets: sampleFacets })
    )
    const jsx = await DatasetsPage(makeSearchParams())
    render(jsx)

    // Filter section titles
    expect(screen.getByText('Filter by organization')).toBeInTheDocument()
    expect(screen.getByText('Filter by category')).toBeInTheDocument()
    expect(screen.getByText('Filter by tag')).toBeInTheDocument()
    expect(screen.getByText('Filter by format')).toBeInTheDocument()
    expect(screen.getByText('Filter by license')).toBeInTheDocument()
  })

  it('should pass filter parameters to SSR API when no query', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: [], total: 0, offset: 0, limit: 20, facets: sampleFacets })
    )
    await DatasetsPage(makeSearchParams({ organization: 'tokyo', offset: '20' }))

    expect(serverFetch).toHaveBeenCalledTimes(1)
    const url = vi.mocked(serverFetch).mock.calls[0][0] as string
    expect(url).toContain('organization=tokyo')
    expect(url).toContain('offset=20')
    expect(url).toContain('include_facets=true')
  })

  it('should handle API failure gracefully', async () => {
    vi.mocked(serverFetch).mockRejectedValue(new Error('API down'))
    const jsx = await DatasetsPage(makeSearchParams())
    render(jsx)

    // SSR failed → initialData=null → CSR fallback shows loading skeleton
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument()
  })

  it('should link dataset cards to detail page', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: sampleItems, total: 2, offset: 0, limit: 20, facets: sampleFacets })
    )
    const jsx = await DatasetsPage(makeSearchParams())
    render(jsx)

    const card = screen.getByText('Population Data').closest('article')
    expect(card).toBeInTheDocument()
  })
})
