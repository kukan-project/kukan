import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'
import AdminJobsPage from '../page'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

const mockPaginatedFetch = {
  items: [] as unknown[],
  loading: false,
  error: null as Error | null,
  fetchPage: vi.fn(),
  offset: 0,
  total: 0,
  pageSize: 20,
  totalPages: 0,
  currentPage: 1,
}
vi.mock('@/hooks/use-paginated-fetch', () => ({
  usePaginatedFetch: vi.fn(() => mockPaginatedFetch),
}))

const mockClientFetch = vi.mocked(clientFetch)
const mockUsePaginatedFetch = vi.mocked(usePaginatedFetch)

function mockFetchResponse(data: unknown) {
  return { ok: true, json: async () => data } as Response
}

describe('AdminJobsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPaginatedFetch.items = []
    mockPaginatedFetch.loading = false
    mockPaginatedFetch.error = null
    mockPaginatedFetch.total = 0
    mockClientFetch.mockResolvedValue(
      mockFetchResponse({
        queue: { pending: 5, inFlight: 2, delayed: 0, dead: 1 },
        jobs: { queued: 3, processing: 1, complete: 10, error: 2 },
      })
    )
    mockUsePaginatedFetch.mockReturnValue(
      mockPaginatedFetch as ReturnType<typeof usePaginatedFetch>
    )
  })

  it('renders the page title', () => {
    render(<AdminJobsPage />)
    expect(screen.getByText('Resource Processing')).toBeInTheDocument()
  })

  it('displays stats cards when data loads', async () => {
    render(<AdminJobsPage />)

    await waitFor(() => {
      // All = 3+1+10+2 = 16
      expect(screen.getByText('16')).toBeInTheDocument()
    })
    expect(screen.getByText('3')).toBeInTheDocument() // queued
    expect(screen.getByText('1')).toBeInTheDocument() // processing
    expect(screen.getByText('10')).toBeInTheDocument() // complete
    expect(screen.getByText('2')).toBeInTheDocument() // error
  })

  it('reprocesses every resource from the content it holds', async () => {
    render(<AdminJobsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Reprocess all' }))
    await waitFor(() =>
      expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/admin/reindex-metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeContent: true }),
      })
    )
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Reprocessing of all resources queued'
    )
  })

  it('says so, and releases the row, when a resource cannot be queued', async () => {
    mockPaginatedFetch.items = [
      {
        id: 'j1',
        resourceId: 'r1',
        status: 'complete',
        error: null,
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
        resourceName: 'data.csv',
        packageId: 'p1',
        packageName: 'pkg',
        packageTitle: null,
      },
    ]
    render(<AdminJobsPage />)
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalled())
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    fireEvent.click(screen.getByTitle('Reprocess'))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTitle('Reprocess')).toBeEnabled())
  })

  it('displays table items when data loads', () => {
    mockPaginatedFetch.items = [
      {
        id: 'j1',
        resourceId: 'r1',
        status: 'complete',
        error: null,
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T01:00:00Z',
        resourceName: 'data.csv',
        packageId: 'p1',
        packageName: 'my-dataset',
        packageTitle: 'My Dataset',
      },
      {
        id: 'j2',
        resourceId: 'r2',
        status: 'error',
        error: 'Timeout exceeded',
        created: '2026-01-02T00:00:00Z',
        updated: '2026-01-02T01:00:00Z',
        resourceName: 'broken.csv',
        packageId: 'p2',
        packageName: 'other-dataset',
        packageTitle: 'Other Dataset',
      },
    ]
    mockPaginatedFetch.total = 2

    render(<AdminJobsPage />)

    expect(screen.getByText('data.csv')).toBeInTheDocument()
    expect(screen.getByText('broken.csv')).toBeInTheDocument()
    expect(screen.getByText('My Dataset')).toBeInTheDocument()
    expect(screen.getByText('Other Dataset')).toBeInTheDocument()
    expect(screen.getByText('Timeout exceeded')).toBeInTheDocument()
  })

  it('shows loading state', () => {
    mockPaginatedFetch.loading = true
    mockPaginatedFetch.items = []

    render(<AdminJobsPage />)

    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('shows error state with retry button', () => {
    mockPaginatedFetch.error = new Error('fail')

    render(<AdminJobsPage />)

    expect(screen.getByText('Failed to load data')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
