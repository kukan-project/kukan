import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'
import AdminHealthPage from '../page'

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

describe('AdminHealthPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUser.sysadmin = true
    mockPaginatedFetch.items = []
    mockPaginatedFetch.loading = false
    mockPaginatedFetch.error = null
    mockPaginatedFetch.total = 0
    mockClientFetch.mockResolvedValue(mockFetchResponse({ ok: 3, error: 1 }))
    mockUsePaginatedFetch.mockReturnValue(mockPaginatedFetch as ReturnType<typeof usePaginatedFetch>)
  })

  it('renders the page title', () => {
    render(<AdminHealthPage />)
    expect(screen.getByText('Health Check')).toBeInTheDocument()
  })

  it('redirects non-sysadmin users', () => {
    mockUser.sysadmin = false
    const { container } = render(<AdminHealthPage />)
    expect(container.innerHTML).toBe('')
  })

  it('displays stats cards when data loads', async () => {
    mockClientFetch.mockResolvedValue(mockFetchResponse({ ok: 10, error: 2 }))
    render(<AdminHealthPage />)

    await waitFor(() => {
      // "All" stat = sum of ok + error = 12
      expect(screen.getByText('12')).toBeInTheDocument()
    })
    expect(screen.getByText('10')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('displays table items when data loads', () => {
    mockPaginatedFetch.items = [
      {
        id: 'r1',
        url: 'https://example.com/data.csv',
        name: 'data.csv',
        healthStatus: 'ok',
        healthCheckedAt: '2026-01-01T00:00:00Z',
        extras: null,
        packageId: 'p1',
        packageName: 'my-dataset',
        packageTitle: 'My Dataset',
      },
      {
        id: 'r2',
        url: 'https://example.com/broken.csv',
        name: 'broken.csv',
        healthStatus: 'error',
        healthCheckedAt: '2026-01-02T00:00:00Z',
        extras: { healthError: '404 Not Found' },
        packageId: 'p2',
        packageName: 'other-dataset',
        packageTitle: null,
      },
    ]
    mockPaginatedFetch.total = 2

    render(<AdminHealthPage />)

    expect(screen.getByText('data.csv')).toBeInTheDocument()
    expect(screen.getByText('broken.csv')).toBeInTheDocument()
    expect(screen.getByText('My Dataset')).toBeInTheDocument()
    expect(screen.getByText('other-dataset')).toBeInTheDocument()
    expect(screen.getByText('404 Not Found')).toBeInTheDocument()
  })

  it('shows loading state', () => {
    mockPaginatedFetch.loading = true
    mockPaginatedFetch.items = []

    render(<AdminHealthPage />)

    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('shows error state with retry button', () => {
    mockPaginatedFetch.error = new Error('fail')

    render(<AdminHealthPage />)

    expect(screen.getByText('Failed to load data')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('shows empty state when no items', () => {
    mockPaginatedFetch.items = []
    mockPaginatedFetch.loading = false
    mockPaginatedFetch.error = null

    render(<AdminHealthPage />)

    expect(screen.getByText('No URL resources')).toBeInTheDocument()
  })
})
