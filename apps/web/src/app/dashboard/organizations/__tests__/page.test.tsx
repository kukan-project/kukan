import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import OrganizationsManagePage from '../page'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

// Mock useUser — sysadmin by default
vi.mock('@/components/dashboard/user-provider', () => ({
  useUser: () => ({
    id: 'u1',
    name: 'Admin',
    email: 'admin@test.com',
    displayName: null,
    sysadmin: true,
  }),
}))

function mockFetchResponse(data: unknown) {
  return { ok: true, json: async () => data } as Response
}

const sampleOrgs = [
  { id: 'o1', name: 'tokyo', title: 'Tokyo Metropolitan', datasetCount: 24 },
  { id: 'o2', name: 'osaka', title: 'Osaka City', datasetCount: 12 },
]

describe('OrganizationsManagePage', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
  })

  it('should display organizations in table', async () => {
    vi.mocked(clientFetch).mockResolvedValue(mockFetchResponse({ items: sampleOrgs, total: 2 }))
    render(<OrganizationsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('tokyo')).toBeInTheDocument()
    })
    expect(screen.getByText('Tokyo Metropolitan')).toBeInTheDocument()
    expect(screen.getByText('24')).toBeInTheDocument()
    expect(screen.getByText('osaka')).toBeInTheDocument()
    expect(screen.getByText('Osaka City')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
  })

  it('should show empty state when no organizations', async () => {
    vi.mocked(clientFetch).mockResolvedValue(mockFetchResponse({ items: [], total: 0 }))
    render(<OrganizationsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('No organizations')).toBeInTheDocument()
    })
  })

  it('should show error state with retry button on fetch failure', async () => {
    vi.mocked(clientFetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response)
    render(<OrganizationsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('Failed to load data')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('should show pagination when total > pageSize', async () => {
    vi.mocked(clientFetch).mockResolvedValue(mockFetchResponse({ items: sampleOrgs, total: 50 }))
    render(<OrganizationsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('1 / 3')).toBeInTheDocument()
    })
    expect(screen.getByText('Next')).toBeInTheDocument()
  })

  it('should not show pagination when total <= pageSize', async () => {
    vi.mocked(clientFetch).mockResolvedValue(mockFetchResponse({ items: sampleOrgs, total: 2 }))
    render(<OrganizationsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('tokyo')).toBeInTheDocument()
    })
    expect(screen.queryByText('Next')).not.toBeInTheDocument()
  })

  it('should show new button for sysadmin', async () => {
    vi.mocked(clientFetch).mockResolvedValue(mockFetchResponse({ items: [], total: 0 }))
    render(<OrganizationsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('No organizations')).toBeInTheDocument()
    })
    const link = screen.getByText('New').closest('a')
    expect(link).toHaveAttribute('href', '/dashboard/organizations/new')
  })

  it('should link to members and view pages', async () => {
    vi.mocked(clientFetch).mockResolvedValue(mockFetchResponse({ items: sampleOrgs, total: 2 }))
    render(<OrganizationsManagePage />)

    await waitFor(() => {
      const memberLinks = screen.getAllByText('Members')
      const link = memberLinks[0].closest('a')
      expect(link).toHaveAttribute('href', '/dashboard/organizations/tokyo/members')
    })

    const viewLinks = screen.getAllByText('View')
    const viewLink = viewLinks[0].closest('a')
    expect(viewLink).toHaveAttribute('href', '/organization/tokyo')
  })
})
