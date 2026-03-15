import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { notFound } from 'next/navigation'
import { serverFetch } from '@/lib/server-api'
import ResourceDetailPage from '../page'

vi.mock('@/lib/server-api', () => ({
  serverFetch: vi.fn(),
}))

function mockResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

const sampleResource: {
  id: string
  packageId: string
  name: string | null
  url: string | null
  description: string
  format: string
  size: number
  mimetype: string
  hash: string
  resourceType: string
  created: string
  updated: string
  lastModified: string
  extras: null
} = {
  id: 'r1',
  packageId: 'pkg-1',
  name: 'population.csv',
  url: 'https://example.com/population.csv',
  description: 'Annual population statistics by ward.',
  format: 'CSV',
  size: 2048576, // ~2 MB
  mimetype: 'text/csv',
  hash: 'abc123def456',
  resourceType: 'file',
  created: '2024-01-15T10:30:00Z',
  updated: '2024-06-20T14:00:00Z',
  lastModified: '2024-05-10T08:00:00Z',
  extras: null,
}

const samplePkg = {
  id: 'pkg-1',
  name: 'population-data',
  title: 'Population Data',
  licenseId: 'CC-BY-4.0',
}

function makeParams(nameOrId: string, resourceId: string) {
  return { params: Promise.resolve({ nameOrId, resourceId }) }
}

describe('ResourceDetailPage', () => {
  beforeEach(() => {
    vi.mocked(serverFetch).mockReset()
    vi.mocked(notFound).mockClear()
  })

  function setupMocks(resource = sampleResource, pkg = samplePkg) {
    vi.mocked(serverFetch).mockImplementation(async (path: string) => {
      if (path.includes('/api/v1/resources/')) return mockResponse(resource)
      if (path.includes('/api/v1/packages/')) return mockResponse(pkg)
      return mockResponse(null, false)
    })
  }

  it('should display resource name and breadcrumb', async () => {
    setupMocks()
    const jsx = await ResourceDetailPage(makeParams('population-data', 'r1'))
    render(jsx)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('population.csv')

    // Breadcrumb: Datasets / Population Data / population.csv
    const datasetLink = screen.getByText('Datasets')
    expect(datasetLink.closest('a')).toHaveAttribute('href', '/dataset')

    const pkgLink = screen.getByText('Population Data')
    expect(pkgLink.closest('a')).toHaveAttribute('href', '/dataset/population-data')
  })

  it('should display format badge', async () => {
    setupMocks()
    const jsx = await ResourceDetailPage(makeParams('population-data', 'r1'))
    render(jsx)

    const formatBadges = screen.getAllByText('CSV')
    expect(formatBadges.length).toBeGreaterThanOrEqual(1)
  })

  it('should display resource URL as link', async () => {
    setupMocks()
    const jsx = await ResourceDetailPage(makeParams('population-data', 'r1'))
    render(jsx)

    const urlLink = screen.getByText('https://example.com/population.csv')
    expect(urlLink.closest('a')).toHaveAttribute('href', 'https://example.com/population.csv')
    expect(urlLink.closest('a')).toHaveAttribute('target', '_blank')
  })

  it('should render description', async () => {
    setupMocks()
    const jsx = await ResourceDetailPage(makeParams('population-data', 'r1'))
    render(jsx)

    expect(screen.getByText('Annual population statistics by ward.')).toBeInTheDocument()
  })

  it('should show preview placeholder', async () => {
    setupMocks()
    const jsx = await ResourceDetailPage(makeParams('population-data', 'r1'))
    render(jsx)

    expect(screen.getByText('Preview')).toBeInTheDocument()
    expect(screen.getByText('Data preview is planned for a future phase')).toBeInTheDocument()
  })

  it('should display additional info table', async () => {
    setupMocks()
    const jsx = await ResourceDetailPage(makeParams('population-data', 'r1'))
    render(jsx)

    expect(screen.getByText('Additional Information')).toBeInTheDocument()
    expect(screen.getByText('Data Format')).toBeInTheDocument()
    expect(screen.getByText('MIME Type')).toBeInTheDocument()
    expect(screen.getByText('text/csv')).toBeInTheDocument()
    expect(screen.getByText('Size')).toBeInTheDocument()
    expect(screen.getByText('2.0 MB')).toBeInTheDocument()
    expect(screen.getByText('Resource Type')).toBeInTheDocument()
    expect(screen.getByText('file')).toBeInTheDocument()
    expect(screen.getByText('Hash')).toBeInTheDocument()
    expect(screen.getByText('abc123def456')).toBeInTheDocument()
    expect(screen.getByText('CC-BY-4.0')).toBeInTheDocument()
  })

  it('should call notFound when resource fetch fails', async () => {
    vi.mocked(serverFetch).mockImplementation(async (path: string) => {
      if (path.includes('/api/v1/resources/')) return mockResponse(null, false)
      return mockResponse(samplePkg)
    })
    await expect(ResourceDetailPage(makeParams('population-data', 'nonexistent'))).rejects.toThrow(
      'NEXT_NOT_FOUND'
    )
    expect(notFound).toHaveBeenCalled()
  })

  it('should handle missing package gracefully', async () => {
    vi.mocked(serverFetch).mockImplementation(async (path: string) => {
      if (path.includes('/api/v1/resources/')) return mockResponse(sampleResource)
      if (path.includes('/api/v1/packages/')) return mockResponse(null, false)
      return mockResponse(null, false)
    })
    const jsx = await ResourceDetailPage(makeParams('unknown-pkg', 'r1'))
    render(jsx)

    // Breadcrumb should fall back to nameOrId
    const pkgLink = screen.getByText('unknown-pkg')
    expect(pkgLink.closest('a')).toHaveAttribute('href', '/dataset/unknown-pkg')
  })

  it('should show unnamed resource when name is null', async () => {
    const noNameResource = { ...sampleResource, name: null }
    setupMocks(noNameResource)
    const jsx = await ResourceDetailPage(makeParams('population-data', 'r1'))
    render(jsx)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Unnamed Resource')
  })

  it('should not show URL section when url is null', async () => {
    const noUrlResource = { ...sampleResource, url: null }
    setupMocks(noUrlResource)
    const jsx = await ResourceDetailPage(makeParams('population-data', 'r1'))
    render(jsx)

    expect(screen.queryByText('https://example.com/population.csv')).not.toBeInTheDocument()
  })
})
