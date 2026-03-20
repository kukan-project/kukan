import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { notFound } from 'next/navigation'
import { serverFetch } from '@/lib/server-api'
import DatasetDetailPage from '../page'

vi.mock('@/lib/server-api', () => ({
  serverFetch: vi.fn(),
}))

// Mock DownloadButton client component
vi.mock('@/components/download-button', () => ({
  DownloadButton: ({ label }: { label: string }) => <button>{label}</button>,
}))

function mockResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

const samplePkg = {
  id: 'pkg-1',
  name: 'population-data',
  title: 'Population Data',
  notes: 'A dataset about **population** statistics.',
  url: 'https://example.com/data',
  version: '1.0',
  licenseId: 'CC-BY-4.0',
  author: 'John Doe',
  authorEmail: 'john@example.com',
  maintainer: 'Jane Doe',
  maintainerEmail: 'jane@example.com',
  private: false,
  created: '2024-01-15T10:30:00Z',
  updated: '2024-06-20T14:00:00Z',
  extras: null,
  resources: [
    {
      id: 'r1',
      name: 'population.csv',
      url: 'https://example.com/population.csv',
      description: 'CSV data file',
      format: 'CSV',
      size: 1024,
      mimetype: 'text/csv',
    },
    {
      id: 'r2',
      name: 'report.pdf',
      url: 'https://example.com/report.pdf',
      description: null,
      format: 'PDF',
      size: null,
      mimetype: null,
    },
  ],
  tags: [
    { id: 't1', name: 'statistics' },
    { id: 't2', name: 'population' },
  ],
  groups: [{ id: 'g1', name: 'demographics', title: 'Demographics' }],
  organization: { id: 'o1', name: 'tokyo', title: 'Tokyo Metropolitan' },
}

function makeParams(nameOrId: string) {
  return { params: Promise.resolve({ nameOrId }) }
}

describe('DatasetDetailPage', () => {
  beforeEach(() => {
    vi.mocked(serverFetch).mockReset()
    vi.mocked(notFound).mockClear()
  })

  it('should display dataset title and breadcrumb', async () => {
    vi.mocked(serverFetch).mockResolvedValue(mockResponse(samplePkg))
    const jsx = await DatasetDetailPage(makeParams('population-data'))
    render(jsx)

    // h1 title
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Population Data')
    // Breadcrumb
    const breadcrumbLink = screen.getByText('Datasets')
    expect(breadcrumbLink.closest('a')).toHaveAttribute('href', '/dataset')
  })

  it('should display organization, groups, and tags', async () => {
    vi.mocked(serverFetch).mockResolvedValue(mockResponse(samplePkg))
    const jsx = await DatasetDetailPage(makeParams('population-data'))
    render(jsx)

    // Organization link
    const orgLink = screen.getByText('Tokyo Metropolitan')
    expect(orgLink.closest('a')).toHaveAttribute('href', '/organization/tokyo')

    // Group link
    const groupLink = screen.getByText('Demographics')
    expect(groupLink.closest('a')).toHaveAttribute('href', '/group/demographics')

    // Tag links
    const statsLink = screen.getByText('statistics').closest('a')
    expect(statsLink).toHaveAttribute('href', '/dataset?tags=statistics')
    const popLink = screen
      .getAllByText('population')
      .find((el) => el.closest('a')?.getAttribute('href')?.includes('tags='))
    expect(popLink).toBeDefined()
  })

  it('should render description with markdown', async () => {
    vi.mocked(serverFetch).mockResolvedValue(mockResponse(samplePkg))
    const jsx = await DatasetDetailPage(makeParams('population-data'))
    render(jsx)

    // Bold markdown should render as <strong>
    const strong = screen.getByText('population', { selector: 'strong' })
    expect(strong.tagName).toBe('STRONG')
    // Surrounding text
    expect(screen.getByText(/statistics\./)).toBeInTheDocument()
  })

  it('should display resource cards', async () => {
    vi.mocked(serverFetch).mockResolvedValue(mockResponse(samplePkg))
    const jsx = await DatasetDetailPage(makeParams('population-data'))
    render(jsx)

    // Resource section header with count
    expect(screen.getByText('Data and Resources (2)')).toBeInTheDocument()

    // Resource names
    const csvLink = screen.getByText('population.csv')
    expect(csvLink.closest('a')).toHaveAttribute('href', '/dataset/population-data/resource/r1')

    const pdfLink = screen.getByText('report.pdf')
    expect(pdfLink.closest('a')).toHaveAttribute('href', '/dataset/population-data/resource/r2')

    // Resource description
    expect(screen.getByText('CSV data file')).toBeInTheDocument()

    // Format badges
    expect(screen.getByText('CSV')).toBeInTheDocument()
    expect(screen.getByText('PDF')).toBeInTheDocument()

    // Download buttons for each resource
    const downloadButtons = screen.getAllByText('Download')
    expect(downloadButtons).toHaveLength(2)
  })

  it('should show no resources message when empty', async () => {
    const pkgNoResources = { ...samplePkg, resources: [] }
    vi.mocked(serverFetch).mockResolvedValue(mockResponse(pkgNoResources))
    const jsx = await DatasetDetailPage(makeParams('population-data'))
    render(jsx)

    expect(screen.getByText('No resources')).toBeInTheDocument()
  })

  it('should display additional info table', async () => {
    vi.mocked(serverFetch).mockResolvedValue(mockResponse(samplePkg))
    const jsx = await DatasetDetailPage(makeParams('population-data'))
    render(jsx)

    expect(screen.getByText('Additional Information')).toBeInTheDocument()
    expect(screen.getByText('Maintainer')).toBeInTheDocument()
    expect(screen.getByText('Jane Doe')).toBeInTheDocument()
    expect(screen.getByText('Author')).toBeInTheDocument()
    expect(screen.getByText('John Doe')).toBeInTheDocument()
    expect(screen.getByText('CC-BY-4.0')).toBeInTheDocument()
    expect(screen.getByText('1.0')).toBeInTheDocument()
  })

  it('should display source URL as link', async () => {
    vi.mocked(serverFetch).mockResolvedValue(mockResponse(samplePkg))
    const jsx = await DatasetDetailPage(makeParams('population-data'))
    render(jsx)

    const sourceLink = screen.getByText('https://example.com/data')
    expect(sourceLink.closest('a')).toHaveAttribute('href', 'https://example.com/data')
    expect(sourceLink.closest('a')).toHaveAttribute('target', '_blank')
  })

  it('should call notFound when fetch fails', async () => {
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network error'))

    await expect(DatasetDetailPage(makeParams('nonexistent'))).rejects.toThrow('NEXT_NOT_FOUND')
    expect(notFound).toHaveBeenCalled()
  })

  it('should call notFound when response is not ok', async () => {
    vi.mocked(serverFetch).mockResolvedValue(mockResponse(null, false))

    await expect(DatasetDetailPage(makeParams('nonexistent'))).rejects.toThrow('NEXT_NOT_FOUND')
    expect(notFound).toHaveBeenCalled()
  })

  it('should use name as fallback when title is null', async () => {
    const pkgNoTitle = { ...samplePkg, title: null }
    vi.mocked(serverFetch).mockResolvedValue(mockResponse(pkgNoTitle))
    const jsx = await DatasetDetailPage(makeParams('population-data'))
    render(jsx)

    // Title falls back to name
    const headings = screen.getAllByText('population-data')
    expect(headings.length).toBeGreaterThanOrEqual(1)
  })
})
