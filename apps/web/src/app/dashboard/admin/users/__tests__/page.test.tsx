import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'
import AdminUsersPage from '../page'

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

describe('AdminUsersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUser.sysadmin = true
    mockPaginatedFetch.items = []
    mockPaginatedFetch.loading = false
    mockPaginatedFetch.error = null
    mockPaginatedFetch.total = 0
    mockClientFetch.mockResolvedValue(
      mockFetchResponse({ total: 15, active: 12, sysadmin: 2, deleted: 3 })
    )
    mockUsePaginatedFetch.mockReturnValue(mockPaginatedFetch as ReturnType<typeof usePaginatedFetch>)
  })

  it('renders the page title', () => {
    render(<AdminUsersPage />)
    expect(screen.getByText('User Management')).toBeInTheDocument()
  })

  it('redirects non-sysadmin users', () => {
    mockUser.sysadmin = false
    const { container } = render(<AdminUsersPage />)
    expect(container.innerHTML).toBe('')
  })

  it('displays stats cards when data loads', async () => {
    render(<AdminUsersPage />)

    await waitFor(() => {
      expect(screen.getByText('2')).toBeInTheDocument() // sysadmin
    })
    // Regular users = active - sysadmin = 12 - 2 = 10
    expect(screen.getByText('10')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument() // deleted
  })

  it('displays table items when data loads', () => {
    mockPaginatedFetch.items = [
      {
        id: 'u2',
        name: 'john-doe',
        email: 'john@example.com',
        displayName: 'John Doe',
        role: 'user',
        state: 'active',
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'u3',
        name: 'jane-admin',
        email: 'jane@example.com',
        displayName: null,
        role: 'sysadmin',
        state: 'active',
        createdAt: '2026-01-02T00:00:00Z',
      },
    ]
    mockPaginatedFetch.total = 2

    render(<AdminUsersPage />)

    expect(screen.getByText('john-doe')).toBeInTheDocument()
    expect(screen.getByText('john@example.com')).toBeInTheDocument()
    expect(screen.getByText('John Doe')).toBeInTheDocument()
    expect(screen.getByText('jane-admin')).toBeInTheDocument()
    expect(screen.getByText('jane@example.com')).toBeInTheDocument()
  })

  it('shows loading state', () => {
    mockPaginatedFetch.loading = true
    mockPaginatedFetch.items = []

    render(<AdminUsersPage />)

    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('shows error state with retry button', () => {
    mockPaginatedFetch.error = new Error('fail')

    render(<AdminUsersPage />)

    expect(screen.getByText('Failed to load data')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('shows create user button', () => {
    render(<AdminUsersPage />)
    expect(screen.getByText('Create User')).toBeInTheDocument()
  })
})
