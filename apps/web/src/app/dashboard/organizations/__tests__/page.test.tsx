import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import OrganizationsManagePage from '../page'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

// Mock useUser — sysadmin by default, mutable per test
const mockUser = vi.hoisted(() => ({
  id: 'u1',
  name: 'Admin',
  email: 'admin@test.com',
  displayName: null as string | null,
  sysadmin: true,
}))

vi.mock('@/components/dashboard/user-provider', () => ({
  useUser: () => mockUser,
}))

function mockFetchResponse(data: unknown) {
  return { ok: true, json: async () => data } as Response
}

const sampleOrgs = [
  {
    id: 'o1',
    name: 'tokyo',
    title: 'Tokyo Metropolitan',
    datasetCount: 24,
    deletedDatasetCount: 3,
  },
  { id: 'o2', name: 'osaka', title: 'Osaka City', datasetCount: 12, deletedDatasetCount: 0 },
]

/** Routes the organization list and the viewer's memberships, which decide
 *  which row actions are offered (kukan#258). Defaults to admin everywhere. */
function mockFetch(list: Response, memberships = sampleOrgs.map((o) => ({ ...o, role: 'admin' }))) {
  vi.mocked(clientFetch).mockImplementation(async (url: string) => {
    if (url.startsWith('/api/v1/users/me/organizations')) {
      return mockFetchResponse({ items: memberships })
    }
    return list
  })
}

describe('OrganizationsManagePage', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
    mockUser.sysadmin = true
  })

  it('should display organizations in table', async () => {
    mockFetch(mockFetchResponse({ items: sampleOrgs, total: 2 }))
    render(<OrganizationsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('tokyo')).toBeInTheDocument()
    })
    expect(screen.getByText('Tokyo Metropolitan')).toBeInTheDocument()
    // tokyo: 24 active + 3 deleted = 27 total, with deleted suffix
    expect(screen.getByText('27')).toBeInTheDocument()
    expect(screen.getByText('(3 deleted)')).toBeInTheDocument()
    expect(screen.getByText('osaka')).toBeInTheDocument()
    expect(screen.getByText('Osaka City')).toBeInTheDocument()
    // osaka: 12 active + 0 deleted = 12 total, suffix still shown as 0
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('(0 deleted)')).toBeInTheDocument()
  })

  it('should show stat cards for public and deleted', async () => {
    mockFetch(mockFetchResponse({ items: sampleOrgs, total: 2 }))
    render(<OrganizationsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('Public')).toBeInTheDocument()
    })
    expect(screen.getByText('Deleted')).toBeInTheDocument()
  })

  it('should not show deleted card for non-sysadmin', async () => {
    mockUser.sysadmin = false
    mockFetch(mockFetchResponse({ items: sampleOrgs, total: 2 }))
    render(<OrganizationsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('Public')).toBeInTheDocument()
    })
    expect(screen.queryByText('Deleted')).not.toBeInTheDocument()
    expect(screen.queryByText('New')).not.toBeInTheDocument()
  })

  it('should switch to deleted list when deleted card is clicked', async () => {
    mockFetch(mockFetchResponse({ items: sampleOrgs, total: 2 }))
    render(<OrganizationsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('Deleted')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Deleted'))

    await waitFor(() => {
      const editLinks = screen.getAllByText('Edit')
      const editLink = editLinks[0].closest('a')
      expect(editLink).toHaveAttribute('href', '/dashboard/organizations/tokyo/edit?state=deleted')
    })
    expect(
      vi
        .mocked(clientFetch)
        .mock.calls.some(([url]) => String(url).includes('state=deleted&limit=20'))
    ).toBe(true)
  })

  it('should show empty state when no organizations', async () => {
    mockFetch(mockFetchResponse({ items: [], total: 0 }))
    render(<OrganizationsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('No organizations')).toBeInTheDocument()
    })
  })

  it('should show error state with retry button on fetch failure', async () => {
    mockFetch({ ok: false, status: 500, json: async () => ({}) } as Response)
    render(<OrganizationsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('Failed to load data')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('should show pagination when total > pageSize', async () => {
    mockFetch(mockFetchResponse({ items: sampleOrgs, total: 50 }))
    render(<OrganizationsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('1 / 3')).toBeInTheDocument()
    })
    expect(screen.getByText('Next')).toBeInTheDocument()
  })

  it('should not show pagination when total <= pageSize', async () => {
    mockFetch(mockFetchResponse({ items: sampleOrgs, total: 2 }))
    render(<OrganizationsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('tokyo')).toBeInTheDocument()
    })
    expect(screen.queryByText('Next')).not.toBeInTheDocument()
  })

  it('should show new button for sysadmin', async () => {
    mockFetch(mockFetchResponse({ items: [], total: 0 }))
    render(<OrganizationsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('No organizations')).toBeInTheDocument()
    })
    const link = screen.getByText('New').closest('a')
    expect(link).toHaveAttribute('href', '/dashboard/organizations/new')
  })

  it('should link to edit, members and view pages', async () => {
    mockFetch(mockFetchResponse({ items: sampleOrgs, total: 2 }))
    render(<OrganizationsManagePage />)

    await waitFor(() => {
      const editLinks = screen.getAllByText('Edit')
      const editLink = editLinks[0].closest('a')
      expect(editLink).toHaveAttribute('href', '/dashboard/organizations/tokyo/edit')
    })

    const memberLinks = screen.getAllByText('Members')
    const memberLink = memberLinks[0].closest('a')
    expect(memberLink).toHaveAttribute('href', '/dashboard/organizations/tokyo/members')

    const viewLinks = screen.getAllByText('View')
    const viewLink = viewLinks[0].closest('a')
    expect(viewLink).toHaveAttribute('href', '/organization/tokyo')
  })

  // Editing needs admin, the member list any role — offering either to
  // everyone only produced an API error on use (kukan#258)
  it('should offer only the member list to a non-admin member', async () => {
    mockUser.sysadmin = false
    mockFetch(mockFetchResponse({ items: sampleOrgs, total: 2 }), [
      { ...sampleOrgs[0], role: 'editor' },
    ])
    render(<OrganizationsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('tokyo')).toBeInTheDocument()
    })
    expect(screen.queryByText('Edit')).not.toBeInTheDocument()
    // Only tokyo is the viewer's; osaka offers nothing but View
    expect(screen.getAllByText('Members')).toHaveLength(1)
    expect(screen.getAllByText('View')).toHaveLength(2)
  })
})
