import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { serverFetch } from '@/lib/server-api'
import OrganizationsPage from '../page'

vi.mock('@/lib/server-api', () => ({
  serverFetch: vi.fn(),
}))

function mockResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

const sampleOrgs = [
  {
    id: 'org-1',
    name: 'tokyo',
    title: 'Tokyo Metropolitan',
    description: 'Tokyo metropolitan government open data portal.',
    imageUrl: 'https://example.com/tokyo.png',
    datasetCount: 42,
  },
  {
    id: 'org-2',
    name: 'osaka',
    title: 'Osaka City',
    description: null,
    imageUrl: null,
    datasetCount: 15,
  },
]

function makeSearchParams(params: Record<string, string> = {}) {
  return { searchParams: Promise.resolve(params) }
}

describe('OrganizationsPage', () => {
  beforeEach(() => {
    vi.mocked(serverFetch).mockReset()
  })

  it('should display organization cards', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: sampleOrgs, total: 2, offset: 0, limit: 20 })
    )
    const jsx = await OrganizationsPage(makeSearchParams())
    render(jsx)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Organizations')
    expect(screen.getByText('2 items')).toBeInTheDocument()
    expect(screen.getByText('Tokyo Metropolitan')).toBeInTheDocument()
    expect(screen.getByText('Osaka City')).toBeInTheDocument()
  })

  it('should show organization description', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: sampleOrgs, total: 2, offset: 0, limit: 20 })
    )
    const jsx = await OrganizationsPage(makeSearchParams())
    render(jsx)

    expect(screen.getByText('Tokyo metropolitan government open data portal.')).toBeInTheDocument()
  })

  it('should show dataset count per organization', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: sampleOrgs, total: 2, offset: 0, limit: 20 })
    )
    const jsx = await OrganizationsPage(makeSearchParams())
    render(jsx)

    expect(screen.getByText('42 datasets')).toBeInTheDocument()
    expect(screen.getByText('15 datasets')).toBeInTheDocument()
  })

  it('should link organization cards to detail page', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: sampleOrgs, total: 2, offset: 0, limit: 20 })
    )
    const jsx = await OrganizationsPage(makeSearchParams())
    render(jsx)

    const link = screen.getByText('Tokyo Metropolitan').closest('a')
    expect(link).toHaveAttribute('href', '/organization/tokyo')
  })

  it('should show empty state when no organizations', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: [], total: 0, offset: 0, limit: 20 })
    )
    const jsx = await OrganizationsPage(makeSearchParams())
    render(jsx)

    expect(screen.getByText('No organizations')).toBeInTheDocument()
  })

  it('should show no-match message when query has no results', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: [], total: 0, offset: 0, limit: 20 })
    )
    const jsx = await OrganizationsPage(makeSearchParams({ q: 'nonexistent' }))
    render(jsx)

    expect(screen.getByText('No organizations matching "nonexistent"')).toBeInTheDocument()
  })

  it('should show pagination when total exceeds limit', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: sampleOrgs, total: 60, offset: 0, limit: 20 })
    )
    const jsx = await OrganizationsPage(makeSearchParams())
    render(jsx)

    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    expect(screen.getByText('Next')).toBeInTheDocument()
  })

  it('should not show pagination when total fits in one page', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: sampleOrgs, total: 2, offset: 0, limit: 20 })
    )
    const jsx = await OrganizationsPage(makeSearchParams())
    render(jsx)

    expect(screen.queryByText('Next')).not.toBeInTheDocument()
  })

  it('should pass query parameters to API', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: [], total: 0, offset: 0, limit: 20 })
    )
    await OrganizationsPage(makeSearchParams({ q: 'test', offset: '20' }))

    expect(serverFetch).toHaveBeenCalledTimes(1)
    const url = vi.mocked(serverFetch).mock.calls[0][0] as string
    expect(url).toContain('q=test')
    expect(url).toContain('offset=20')
  })

  it('should handle API failure gracefully', async () => {
    vi.mocked(serverFetch).mockRejectedValue(new Error('API down'))
    const jsx = await OrganizationsPage(makeSearchParams())
    render(jsx)

    expect(screen.getByText('No organizations')).toBeInTheDocument()
    expect(screen.getByText('0 items')).toBeInTheDocument()
  })

  it('should use name as fallback when title is null', async () => {
    const orgNoTitle = [{ ...sampleOrgs[0], title: null }]
    vi.mocked(serverFetch).mockResolvedValue(
      mockResponse({ items: orgNoTitle, total: 1, offset: 0, limit: 20 })
    )
    const jsx = await OrganizationsPage(makeSearchParams())
    render(jsx)

    // Falls back to name "tokyo"
    const link = screen.getByText('tokyo').closest('a')
    expect(link).toHaveAttribute('href', '/organization/tokyo')
  })
})
