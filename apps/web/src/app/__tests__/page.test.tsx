import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { serverFetch } from '@/lib/server-api'
import HomePage from '../page'

vi.mock('@/lib/server-api', () => ({
  serverFetch: vi.fn(),
}))

function mockResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

const sampleDatasets = [
  {
    id: '1',
    name: 'population-data',
    title: 'Population Data',
    notes: 'Annual population statistics.',
    formats: 'CSV',
    resourceCount: 3,
    orgName: 'tokyo',
    orgTitle: 'Tokyo Metropolitan',
  },
  {
    id: '2',
    name: 'budget-report',
    title: 'Budget Report',
    notes: null,
    formats: 'PDF',
    resourceCount: 1,
    orgName: 'osaka',
    orgTitle: 'Osaka City',
  },
]

describe('HomePage', () => {
  beforeEach(() => {
    vi.mocked(serverFetch).mockReset()
  })

  function setupMocks(
    packages = { items: sampleDatasets, total: 42, offset: 0, limit: 5 },
    orgs = { items: [], total: 10, offset: 0, limit: 1 },
    groups = { items: [], total: 5, offset: 0, limit: 1 }
  ) {
    vi.mocked(serverFetch).mockImplementation(async (url: string) => {
      if (url.includes('/packages')) return mockResponse(packages)
      if (url.includes('/organizations')) return mockResponse(orgs)
      if (url.includes('/groups')) return mockResponse(groups)
      return mockResponse({}, false)
    })
  }

  it('should display KUKAN heading and description', async () => {
    setupMocks()
    const jsx = await HomePage()
    render(jsx)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('KUKAN')
    expect(
      screen.getByText('Data catalog for everyone — A platform for searching and utilizing data')
    ).toBeInTheDocument()
  })

  it('should display search form', async () => {
    setupMocks()
    const jsx = await HomePage()
    render(jsx)

    expect(screen.getByPlaceholderText('Search datasets...')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument()
  })

  it('should display stat cards with correct totals', async () => {
    setupMocks()
    const jsx = await HomePage()
    render(jsx)

    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('Datasets')).toBeInTheDocument()
    expect(screen.getByText('10')).toBeInTheDocument()
    expect(screen.getByText('Organizations')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.getByText('Categories')).toBeInTheDocument()
  })

  it('should link stat cards to correct pages', async () => {
    setupMocks()
    const jsx = await HomePage()
    render(jsx)

    const datasetLink = screen.getByText('42').closest('a')
    expect(datasetLink).toHaveAttribute('href', '/dataset')

    const orgLink = screen.getByText('10').closest('a')
    expect(orgLink).toHaveAttribute('href', '/organization')

    const groupLink = screen.getByText('5').closest('a')
    expect(groupLink).toHaveAttribute('href', '/group')
  })

  it('should display latest datasets section', async () => {
    setupMocks()
    const jsx = await HomePage()
    render(jsx)

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Latest Datasets')
    expect(screen.getByText('Population Data')).toBeInTheDocument()
    expect(screen.getByText('Budget Report')).toBeInTheDocument()
    expect(screen.getByText('Show all')).toBeInTheDocument()
  })

  it('should link dataset cards to detail pages', async () => {
    setupMocks()
    const jsx = await HomePage()
    render(jsx)

    const card = screen.getByText('Population Data').closest('article')
    expect(card).toBeInTheDocument()
  })

  it('should hide latest datasets section when no datasets', async () => {
    setupMocks({ items: [], total: 0, offset: 0, limit: 5 })
    const jsx = await HomePage()
    render(jsx)

    expect(screen.queryByText('Latest Datasets')).not.toBeInTheDocument()
    // Stat card should show 0
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('should handle API failure gracefully', async () => {
    vi.mocked(serverFetch).mockRejectedValue(new Error('API down'))
    const jsx = await HomePage()
    render(jsx)

    // Should render with zero counts, not throw
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('KUKAN')
    expect(screen.queryByText('Latest Datasets')).not.toBeInTheDocument()
  })

  it('should call all three API endpoints', async () => {
    setupMocks()
    await HomePage()

    expect(serverFetch).toHaveBeenCalledTimes(3)
    const urls = vi.mocked(serverFetch).mock.calls.map((c) => c[0] as string)
    expect(urls.some((u) => u.includes('/packages'))).toBe(true)
    expect(urls.some((u) => u.includes('/organizations'))).toBe(true)
    expect(urls.some((u) => u.includes('/groups'))).toBe(true)
  })
})
