import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { serverFetch } from '@/lib/server-api'
import GroupDatasetsPage from '../page'

vi.mock('@/lib/server-api', () => ({
  serverFetch: vi.fn(),
}))

function mockResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

const sampleGroup = {
  id: 'g1',
  name: 'demographics',
  title: 'Demographics',
  description: 'Population and demographics data.',
  imageUrl: null,
}

const sampleDatasets = [
  {
    id: 'pkg-1',
    name: 'population-data',
    title: 'Population Data',
    notes: 'Annual population statistics.',
    formats: 'CSV',
    resourceCount: 3,
    orgName: 'tokyo',
    orgTitle: 'Tokyo Metropolitan',
  },
  {
    id: 'pkg-2',
    name: 'census-2024',
    title: 'Census 2024',
    notes: null,
    formats: 'XLSX',
    resourceCount: 1,
    orgName: 'osaka',
    orgTitle: 'Osaka City',
  },
]

function makeProps(nameOrId: string, searchParams: Record<string, string> = {}) {
  return {
    params: Promise.resolve({ nameOrId }),
    searchParams: Promise.resolve(searchParams),
  }
}

describe('GroupDatasetsPage', () => {
  beforeEach(() => {
    vi.mocked(serverFetch).mockReset()
  })

  it('should display group title and breadcrumb', async () => {
    vi.mocked(serverFetch)
      .mockResolvedValueOnce(mockResponse(sampleGroup))
      .mockResolvedValueOnce(
        mockResponse({ items: sampleDatasets, total: 2, offset: 0, limit: 20 })
      )
    const jsx = await GroupDatasetsPage(makeProps('demographics'))
    render(jsx)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Demographics')
    const breadcrumbLink = screen.getByText('Categories')
    expect(breadcrumbLink.closest('a')).toHaveAttribute('href', '/group')
  })

  it('should display group description', async () => {
    vi.mocked(serverFetch)
      .mockResolvedValueOnce(mockResponse(sampleGroup))
      .mockResolvedValueOnce(
        mockResponse({ items: sampleDatasets, total: 2, offset: 0, limit: 20 })
      )
    const jsx = await GroupDatasetsPage(makeProps('demographics'))
    render(jsx)

    expect(screen.getByText('Population and demographics data.')).toBeInTheDocument()
  })

  it('should display dataset cards', async () => {
    vi.mocked(serverFetch)
      .mockResolvedValueOnce(mockResponse(sampleGroup))
      .mockResolvedValueOnce(
        mockResponse({ items: sampleDatasets, total: 2, offset: 0, limit: 20 })
      )
    const jsx = await GroupDatasetsPage(makeProps('demographics'))
    render(jsx)

    expect(screen.getByText('2 datasets')).toBeInTheDocument()
    expect(screen.getByText('Population Data')).toBeInTheDocument()
    expect(screen.getByText('Census 2024')).toBeInTheDocument()
  })

  it('should show empty state when no datasets', async () => {
    vi.mocked(serverFetch)
      .mockResolvedValueOnce(mockResponse(sampleGroup))
      .mockResolvedValueOnce(mockResponse({ items: [], total: 0, offset: 0, limit: 20 }))
    const jsx = await GroupDatasetsPage(makeProps('demographics'))
    render(jsx)

    expect(screen.getByText('No results')).toBeInTheDocument()
  })

  it('should pass group filter to packages API', async () => {
    vi.mocked(serverFetch)
      .mockResolvedValueOnce(mockResponse(sampleGroup))
      .mockResolvedValueOnce(mockResponse({ items: [], total: 0, offset: 0, limit: 20 }))
    await GroupDatasetsPage(makeProps('demographics', { q: 'test', offset: '20' }))

    expect(serverFetch).toHaveBeenCalledTimes(2)
    // First call: group detail
    const groupUrl = vi.mocked(serverFetch).mock.calls[0][0] as string
    expect(groupUrl).toContain('/api/v1/groups/demographics')
    // Second call: packages filtered by group
    const pkgUrl = vi.mocked(serverFetch).mock.calls[1][0] as string
    expect(pkgUrl).toContain('group=demographics')
    expect(pkgUrl).toContain('q=test')
    expect(pkgUrl).toContain('offset=20')
  })

  it('should show pagination when total exceeds limit', async () => {
    vi.mocked(serverFetch)
      .mockResolvedValueOnce(mockResponse(sampleGroup))
      .mockResolvedValueOnce(
        mockResponse({ items: sampleDatasets, total: 60, offset: 0, limit: 20 })
      )
    const jsx = await GroupDatasetsPage(makeProps('demographics'))
    render(jsx)

    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    expect(screen.getByText('Next')).toBeInTheDocument()
  })

  it('should handle group fetch failure gracefully', async () => {
    vi.mocked(serverFetch)
      .mockResolvedValueOnce(mockResponse(null, false))
      .mockResolvedValueOnce(
        mockResponse({ items: sampleDatasets, total: 2, offset: 0, limit: 20 })
      )
    const jsx = await GroupDatasetsPage(makeProps('demographics'))
    render(jsx)

    // Falls back to nameOrId as title
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('demographics')
  })

  it('should handle both fetches failing gracefully', async () => {
    vi.mocked(serverFetch)
      .mockRejectedValueOnce(new Error('API down'))
      .mockRejectedValueOnce(new Error('API down'))
    const jsx = await GroupDatasetsPage(makeProps('demographics'))
    render(jsx)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('demographics')
    expect(screen.getByText('No results')).toBeInTheDocument()
  })

  it('should use name as fallback when group title is null', async () => {
    const groupNoTitle = { ...sampleGroup, title: null }
    vi.mocked(serverFetch)
      .mockResolvedValueOnce(mockResponse(groupNoTitle))
      .mockResolvedValueOnce(mockResponse({ items: [], total: 0, offset: 0, limit: 20 }))
    const jsx = await GroupDatasetsPage(makeProps('demographics'))
    render(jsx)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('demographics')
  })
})
