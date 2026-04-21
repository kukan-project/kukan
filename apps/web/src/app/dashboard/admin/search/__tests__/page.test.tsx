import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import AdminSearchPage from '../page'

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

// Mock react-json-view-lite to avoid rendering issues in tests
vi.mock('react-json-view-lite', () => ({
  JsonView: () => null,
  collapseAllNested: () => false,
  darkStyles: {},
  defaultStyles: {},
}))

const mockClientFetch = vi.mocked(clientFetch)

function mockFetchResponse(data: unknown) {
  return { ok: true, json: async () => data } as Response
}

const mockStats = {
  enabled: true,
  stats: {
    packages: { docCount: 100, sizeBytes: 1024 * 1024, recentDocs: [] },
    resources: { docCount: 500, sizeBytes: 5 * 1024 * 1024, recentDocs: [] },
    contents: { docCount: 200, sizeBytes: 50 * 1024 * 1024, recentDocs: [] },
  },
}

const mockBrowseEmpty = { items: [], total: 0, offset: 0, limit: 20 }

describe('AdminSearchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUser.sysadmin = true
    mockClientFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/stats')) {
        return mockFetchResponse(mockStats)
      }
      if (typeof path === 'string' && path.includes('/browse/')) {
        return mockFetchResponse(mockBrowseEmpty)
      }
      return mockFetchResponse({})
    })
  })

  it('renders the page title', () => {
    render(<AdminSearchPage />)
    expect(screen.getByText('Index Management')).toBeInTheDocument()
  })

  it('redirects non-sysadmin users', () => {
    mockUser.sysadmin = false
    const { container } = render(<AdminSearchPage />)
    expect(container.innerHTML).toBe('')
  })

  it('displays index stats cards', async () => {
    render(<AdminSearchPage />)

    await waitFor(() => {
      expect(screen.getByText('kukan-packages')).toBeInTheDocument()
    })
    expect(screen.getByText('kukan-resources')).toBeInTheDocument()
    expect(screen.getByText('kukan-contents')).toBeInTheDocument()
  })

  it('shows browse items in table', async () => {
    mockClientFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/stats')) {
        return mockFetchResponse(mockStats)
      }
      if (typeof path === 'string' && path.includes('/browse/')) {
        return mockFetchResponse({
          items: [
            { id: 'pkg-1', source: { title: 'Test Dataset', name: 'test-dataset' } },
            { id: 'pkg-2', source: { title: 'Another Dataset', name: 'another' } },
          ],
          total: 2,
          offset: 0,
          limit: 20,
        })
      }
      return mockFetchResponse({})
    })

    render(<AdminSearchPage />)

    await waitFor(() => {
      expect(screen.getByText('pkg-1')).toBeInTheDocument()
    })
    expect(screen.getByText('Test Dataset')).toBeInTheDocument()
    expect(screen.getByText('pkg-2')).toBeInTheDocument()
  })

  it('shows no documents state', async () => {
    render(<AdminSearchPage />)

    await waitFor(() => {
      expect(screen.getByText('No documents')).toBeInTheDocument()
    })
  })

  it('renders the reindex section', () => {
    render(<AdminSearchPage />)

    expect(screen.getByText('Rebuild Search Index')).toBeInTheDocument()
    expect(screen.getByText('Rebuild')).toBeInTheDocument()
  })

  it('has a search input and button', () => {
    render(<AdminSearchPage />)

    expect(screen.getByPlaceholderText('Search documents...')).toBeInTheDocument()
    expect(screen.getByText('Search')).toBeInTheDocument()
  })
})
