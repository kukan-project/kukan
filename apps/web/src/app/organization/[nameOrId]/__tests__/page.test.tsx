import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { serverFetch } from '@/lib/server-api'
import OrganizationDatasetsPage from '../page'

vi.mock('@/lib/server-api', () => ({
  serverFetch: vi.fn(),
}))

function mockResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

const sampleOrg = {
  id: 'org-1',
  name: 'tokyo',
  title: 'Tokyo Metropolitan',
  description: 'Tokyo metropolitan government open data portal.',
  imageUrl: 'https://example.com/tokyo.png',
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
    name: 'budget-report',
    title: 'Budget Report',
    notes: null,
    formats: 'PDF,XLSX',
    resourceCount: 1,
    orgName: 'tokyo',
    orgTitle: 'Tokyo Metropolitan',
  },
]

function makeProps(nameOrId: string, searchParams: Record<string, string> = {}) {
  return {
    params: Promise.resolve({ nameOrId }),
    searchParams: Promise.resolve(searchParams),
  }
}

describe('OrganizationDatasetsPage', () => {
  beforeEach(() => {
    vi.mocked(serverFetch).mockReset()
  })

  it('should display organization title and breadcrumb', async () => {
    vi.mocked(serverFetch)
      .mockResolvedValueOnce(mockResponse(sampleOrg))
      .mockResolvedValueOnce(
        mockResponse({ items: sampleDatasets, total: 2, offset: 0, limit: 20 })
      )
    const jsx = await OrganizationDatasetsPage(makeProps('tokyo'))
    render(jsx)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Tokyo Metropolitan')
    const breadcrumbLink = screen.getByText('Organizations')
    expect(breadcrumbLink.closest('a')).toHaveAttribute('href', '/organization')
  })

  it('should display organization description', async () => {
    vi.mocked(serverFetch)
      .mockResolvedValueOnce(mockResponse(sampleOrg))
      .mockResolvedValueOnce(
        mockResponse({ items: sampleDatasets, total: 2, offset: 0, limit: 20 })
      )
    const jsx = await OrganizationDatasetsPage(makeProps('tokyo'))
    render(jsx)

    expect(screen.getByText('Tokyo metropolitan government open data portal.')).toBeInTheDocument()
  })

  it('should display dataset count', async () => {
    vi.mocked(serverFetch)
      .mockResolvedValueOnce(mockResponse(sampleOrg))
      .mockResolvedValueOnce(
        mockResponse({ items: sampleDatasets, total: 2, offset: 0, limit: 20 })
      )
    const jsx = await OrganizationDatasetsPage(makeProps('tokyo'))
    render(jsx)

    expect(screen.getByText('2 datasets')).toBeInTheDocument()
  })

  it('should display dataset cards', async () => {
    vi.mocked(serverFetch)
      .mockResolvedValueOnce(mockResponse(sampleOrg))
      .mockResolvedValueOnce(
        mockResponse({ items: sampleDatasets, total: 2, offset: 0, limit: 20 })
      )
    const jsx = await OrganizationDatasetsPage(makeProps('tokyo'))
    render(jsx)

    expect(screen.getByText('Population Data')).toBeInTheDocument()
    expect(screen.getByText('Budget Report')).toBeInTheDocument()
  })

  it('should show empty state when no datasets', async () => {
    vi.mocked(serverFetch)
      .mockResolvedValueOnce(mockResponse(sampleOrg))
      .mockResolvedValueOnce(mockResponse({ items: [], total: 0, offset: 0, limit: 20 }))
    const jsx = await OrganizationDatasetsPage(makeProps('tokyo'))
    render(jsx)

    expect(screen.getByText('No results')).toBeInTheDocument()
  })

  it('should show pagination when total exceeds limit', async () => {
    vi.mocked(serverFetch)
      .mockResolvedValueOnce(mockResponse(sampleOrg))
      .mockResolvedValueOnce(
        mockResponse({ items: sampleDatasets, total: 60, offset: 0, limit: 20 })
      )
    const jsx = await OrganizationDatasetsPage(makeProps('tokyo'))
    render(jsx)

    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    expect(screen.getByText('Next')).toBeInTheDocument()
  })

  it('should pass owner_org and query parameters to API', async () => {
    vi.mocked(serverFetch)
      .mockResolvedValueOnce(mockResponse(sampleOrg))
      .mockResolvedValueOnce(mockResponse({ items: [], total: 0, offset: 0, limit: 20 }))
    await OrganizationDatasetsPage(makeProps('tokyo', { q: 'test', offset: '20' }))

    expect(serverFetch).toHaveBeenCalledTimes(2)
    // First call: org detail
    expect(vi.mocked(serverFetch).mock.calls[0][0]).toContain('/api/v1/organizations/tokyo')
    // Second call: packages with organization filter
    const packagesUrl = vi.mocked(serverFetch).mock.calls[1][0] as string
    expect(packagesUrl).toContain('organization=tokyo')
    expect(packagesUrl).toContain('q=test')
    expect(packagesUrl).toContain('offset=20')
  })

  it('should handle org fetch failure gracefully', async () => {
    vi.mocked(serverFetch)
      .mockRejectedValueOnce(new Error('API down'))
      .mockRejectedValueOnce(new Error('API down'))
    const jsx = await OrganizationDatasetsPage(makeProps('tokyo'))
    render(jsx)

    // Falls back to nameOrId as title
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('tokyo')
    expect(screen.getByText('No results')).toBeInTheDocument()
  })

  it('should use nameOrId as fallback when org has no title', async () => {
    const orgNoTitle = { ...sampleOrg, title: null, name: null }
    vi.mocked(serverFetch)
      .mockResolvedValueOnce(mockResponse(orgNoTitle))
      .mockResolvedValueOnce(mockResponse({ items: [], total: 0, offset: 0, limit: 20 }))
    const jsx = await OrganizationDatasetsPage(makeProps('tokyo'))
    render(jsx)

    // Falls back to nameOrId param
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('tokyo')
  })

  it('should not show description when org has none', async () => {
    const orgNoDesc = { ...sampleOrg, description: null }
    vi.mocked(serverFetch)
      .mockResolvedValueOnce(mockResponse(orgNoDesc))
      .mockResolvedValueOnce(
        mockResponse({ items: sampleDatasets, total: 2, offset: 0, limit: 20 })
      )
    const jsx = await OrganizationDatasetsPage(makeProps('tokyo'))
    render(jsx)

    expect(
      screen.queryByText('Tokyo metropolitan government open data portal.')
    ).not.toBeInTheDocument()
  })
})
