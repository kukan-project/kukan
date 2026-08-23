import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import GroupsManagePage from '../page'

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

const sampleGroups = [
  { id: 'g1', name: 'demographics', title: 'Demographics', datasetCount: 12, memberCount: 4 },
  { id: 'g2', name: 'environment', title: 'Environment', datasetCount: 8, memberCount: 1 },
]

/** Routes the category list and the viewer's memberships, which decide which
 *  row actions are offered. Defaults to admin in every category. */
function mockFetch(
  list: Response,
  memberships = sampleGroups.map((g) => ({ ...g, role: 'admin' }))
) {
  vi.mocked(clientFetch).mockImplementation(async (url: string) => {
    if (url.startsWith('/api/v1/users/me/groups')) return mockFetchResponse({ items: memberships })
    return list
  })
}

describe('GroupsManagePage', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
    mockPush.mockClear()
    mockUser.sysadmin = true
  })

  it('should display groups in table', async () => {
    mockFetch(mockFetchResponse({ items: sampleGroups, total: 2 }))
    render(<GroupsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('demographics')).toBeInTheDocument()
    })
    expect(screen.getByText('Demographics')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('environment')).toBeInTheDocument()
    expect(screen.getByText('Environment')).toBeInTheDocument()
    expect(screen.getByText('8')).toBeInTheDocument()
  })

  it('should show empty state when no groups', async () => {
    mockFetch(mockFetchResponse({ items: [], total: 0 }))
    render(<GroupsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('No categories')).toBeInTheDocument()
    })
  })

  it('should show pagination when total > pageSize', async () => {
    mockFetch(mockFetchResponse({ items: sampleGroups, total: 50 }))
    render(<GroupsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('1 / 3')).toBeInTheDocument()
    })
    expect(screen.getByText('Next')).toBeInTheDocument()
  })

  it('should not show pagination when total <= pageSize', async () => {
    mockFetch(mockFetchResponse({ items: sampleGroups, total: 2 }))
    render(<GroupsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('demographics')).toBeInTheDocument()
    })
    expect(screen.queryByText('Next')).not.toBeInTheDocument()
  })

  it('should show new button', async () => {
    mockFetch(mockFetchResponse({ items: [], total: 0 }))
    render(<GroupsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('No categories')).toBeInTheDocument()
    })
    expect(screen.getByText('New')).toBeInTheDocument()
    const link = screen.getByText('New').closest('a')
    expect(link).toHaveAttribute('href', '/dashboard/groups/new')
  })

  it('should hide the new button from non-sysadmins', async () => {
    // Creating a category is sysadmin-only server-side
    mockUser.sysadmin = false
    mockFetch(mockFetchResponse({ items: [], total: 0 }))
    render(<GroupsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('No categories')).toBeInTheDocument()
    })
    expect(screen.queryByText('New')).not.toBeInTheDocument()
  })

  it('should show error state with retry button on fetch failure', async () => {
    mockFetch({ ok: false, status: 500, json: async () => ({}) } as Response)
    render(<GroupsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('Failed to load data')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('opens edit on row click, and links to members and view pages', async () => {
    // Through the helper: the row actions are gated on the viewer's membership
    // now, so the list alone is not enough to render them.
    mockFetch(mockFetchResponse({ items: sampleGroups, total: 2 }))
    render(<GroupsManagePage />)

    await waitFor(() => expect(screen.getByText('demographics')).toBeInTheDocument())
    fireEvent.click(screen.getByText('demographics'))
    expect(mockPush).toHaveBeenCalledWith('/dashboard/groups/demographics/edit')

    const memberLink = screen.getByText('Members (4)').closest('a')
    expect(memberLink).toHaveAttribute('href', '/dashboard/groups/demographics/members')

    const viewLinks = screen.getAllByText('View')
    const viewLink = viewLinks[0].closest('a')
    expect(viewLink).toHaveAttribute('href', '/group/demographics')
  })

  // Editing needs admin, the member list any role — offering either to
  // everyone only produced an API error on use
  it('should offer only the member list to a non-admin member', async () => {
    mockUser.sysadmin = false
    mockFetch(mockFetchResponse({ items: sampleGroups, total: 2 }), [
      { ...sampleGroups[0], role: 'member' },
    ])
    render(<GroupsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('demographics')).toBeInTheDocument()
    })
    expect(screen.queryByText('Edit')).not.toBeInTheDocument()
    // Only demographics is the viewer's; environment offers nothing but View
    expect(screen.getAllByText(/^Members/)).toHaveLength(1)
    expect(screen.getByText('Members (4)')).toBeInTheDocument()
    expect(screen.getAllByText('View')).toHaveLength(2)
  })

  // The count comes from the list API only for the viewer's own categories; the
  // action itself is gated the same way, so a missing count still links out
  it('should label the member action without a count when the API withholds it', async () => {
    mockFetch(
      mockFetchResponse({
        items: sampleGroups.map((g) => ({ ...g, memberCount: null })),
        total: 2,
      })
    )
    render(<GroupsManagePage />)

    await waitFor(() => expect(screen.getByText('demographics')).toBeInTheDocument())
    expect(screen.getAllByText('Members')).toHaveLength(2)
  })
})
