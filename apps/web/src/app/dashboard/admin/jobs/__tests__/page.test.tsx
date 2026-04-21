import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'
import AdminJobsPage from '../page'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockUser = { id: 'u1', name: 'admin', email: 'admin@test.com', sysadmin: true }
vi.mock('@/components/dashboard/user-provider', () => ({
  useUser: () => mockUser,
}))

const mockReplace = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: mockReplace, back: vi.fn() }),
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
    mockUser.sysadmin = true
    mockPaginatedFetch.items = []
    mockPaginatedFetch.loading = false
    mockPaginatedFetch.error = null
    mockPaginatedFetch.total = 0
    mockClientFetch.mockResolvedValue(
      mockFetchResponse({
        queue: { pending: 5, inFlight: 2, delayed: 0 },
        jobs: { queued: 3, processing: 1, complete: 10, error: 2 },
      })
    )
    mockUsePaginatedFetch.mockReturnValue(mockPaginatedFetch as ReturnType<typeof usePaginatedFetch>)
  })

  it('renders the page title', () => {
    render(<AdminJobsPage />)
    expect(screen.getByText('Job Management')).toBeInTheDocument()
  })

  it('redirects non-sysadmin users', () => {
    mockUser.sysadmin = false
    const { container } = render(<AdminJobsPage />)
    expect(container.innerHTML).toBe('')
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

  it('displays SQS queue info when stats load', async () => {
    render(<AdminJobsPage />)

    await waitFor(() => {
      expect(screen.getByText('SQS: pending 5 / in-flight 2')).toBeInTheDocument()
    })
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
