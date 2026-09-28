import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'
import { useVisibleInterval } from '@/hooks/use-visible-interval'
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
  refresh: vi.fn(),
  offset: 0,
  total: 0,
  pageSize: 20,
  totalPages: 0,
  currentPage: 1,
}
vi.mock('@/hooks/use-paginated-fetch', () => ({
  usePaginatedFetch: vi.fn(() => mockPaginatedFetch),
}))

vi.mock('@/hooks/use-visible-interval', () => ({
  useVisibleInterval: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)
const mockUseVisibleInterval = vi.mocked(useVisibleInterval)
const lastPoll = () => mockUseVisibleInterval.mock.calls.at(-1)!
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
    mockPaginatedFetch.offset = 0
    mockClientFetch.mockResolvedValue(
      mockFetchResponse({
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

  it('places the reprocess of every resource above the status cards', () => {
    render(<AdminJobsPage />)

    const reprocess = screen.getByText('Reprocess all resources')
    const cards = screen.getByText('All')
    expect(reprocess.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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

  it('polls the stats and the page shown, spinning the refresh icon meanwhile', async () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<AdminJobsPage />)
      await act(async () => {})
      const spinning = () => container.querySelector('svg.animate-spin')
      mockClientFetch.mockClear()

      let settled = false
      act(() => {
        ;(lastPoll()[0]() as Promise<void>).then(() => (settled = true))
      })

      expect(mockPaginatedFetch.refresh).toHaveBeenCalled()
      expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/admin/jobs/stats')
      expect(spinning()).not.toBeNull()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(settled).toBe(true)
      expect(spinning()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks a reprocessed row until the polls show it done', async () => {
    const row = {
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
    }
    mockPaginatedFetch.items = [row]
    const { rerender } = render(<AdminJobsPage />)
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalled())

    fireEvent.click(screen.getByTitle('Reprocess'))
    await waitFor(() =>
      expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/resources/r1/run-pipeline', {
        method: 'POST',
      })
    )
    // The run before it, still on screen until the next fetch, is not its end
    rerender(<AdminJobsPage />)
    await waitFor(() => expect(screen.getByTitle('Reprocess')).toBeDisabled())

    mockPaginatedFetch.items = [{ ...row, status: 'queued', updated: '2026-01-01T00:01:00Z' }]
    rerender(<AdminJobsPage />)
    expect(screen.getByTitle('Reprocess')).toBeDisabled()

    mockPaginatedFetch.items = [{ ...row, status: 'complete', updated: '2026-01-01T00:02:00Z' }]
    rerender(<AdminJobsPage />)
    await waitFor(() => expect(screen.getByTitle('Reprocess')).toBeEnabled())
  })
})
