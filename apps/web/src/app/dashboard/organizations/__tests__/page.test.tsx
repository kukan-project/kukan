import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import OrganizationsManagePage from '../page'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
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
    memberCount: 5,
  },
  {
    id: 'o2',
    name: 'osaka',
    title: 'Osaka City',
    datasetCount: 12,
    deletedDatasetCount: 0,
    memberCount: 2,
  },
]

/** Routes the organization list and the viewer's memberships, which decide
 *  which row actions are offered. Defaults to admin everywhere. */
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
    mockPush.mockClear()
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
      expect(
        vi
          .mocked(clientFetch)
          .mock.calls.some(([url]) => String(url).includes('state=deleted&limit=20'))
      ).toBe(true)
    })
    // A deleted-org row click navigates to its edit page in the deleted state.
    fireEvent.click(screen.getByText('tokyo'))
    expect(mockPush).toHaveBeenCalledWith('/dashboard/organizations/tokyo/edit?state=deleted')
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

  it('opens edit on row click, and links to members and view pages', async () => {
    // Through the helper: the row actions are gated on the viewer's membership
    // now, so the list alone is not enough to render them (#258).
    mockFetch(mockFetchResponse({ items: sampleOrgs, total: 2 }))
    render(<OrganizationsManagePage />)

    await waitFor(() => expect(screen.getByText('tokyo')).toBeInTheDocument())
    fireEvent.click(screen.getByText('tokyo'))
    expect(mockPush).toHaveBeenCalledWith('/dashboard/organizations/tokyo/edit')

    const memberLink = screen.getByText('Members (5)').closest('a')
    expect(memberLink).toHaveAttribute('href', '/dashboard/organizations/tokyo/members')

    const viewLinks = screen.getAllByText('View')
    const viewLink = viewLinks[0].closest('a')
    expect(viewLink).toHaveAttribute('href', '/organization/tokyo')
  })

  // Editing needs admin, the member list any role — offering either to
  // everyone only produced an API error on use
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
    expect(screen.getAllByText(/^Members/)).toHaveLength(1)
    expect(screen.getByText('Members (5)')).toBeInTheDocument()
    expect(screen.getAllByText('View')).toHaveLength(2)
  })

  // The count comes from the list API only for the viewer's own organizations;
  // the action itself is gated the same way, so a missing count still links out
  it('should label the member action without a count when the API withholds it', async () => {
    mockFetch(
      mockFetchResponse({
        items: sampleOrgs.map((o) => ({ ...o, memberCount: null })),
        total: 2,
      })
    )
    render(<OrganizationsManagePage />)

    await waitFor(() => expect(screen.getByText('tokyo')).toBeInTheDocument())
    expect(screen.getAllByText('Members')).toHaveLength(2)
  })
})
