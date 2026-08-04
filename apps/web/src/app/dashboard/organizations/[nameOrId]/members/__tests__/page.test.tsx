import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

const members = [
  {
    id: 'm1',
    userId: 'u1',
    role: 'admin',
    userName: 'admin-user',
    email: 'admin@test.com',
    created: '2026-01-01',
  },
]

/** Routes the member list and the viewer's memberships, which decide whether
 *  the add/remove controls are offered (kukan#258) */
function mockFetch(items: unknown[] = [], role: string | null = null) {
  mockClientFetch.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/v1/users/me/organizations')) {
      return jsonResponse({ items: role ? [{ id: 'o1', name: 'test-entity', role }] : [] })
    }
    return jsonResponse({ items })
  })
}

import OrgMembersPage from '../page'

describe('OrgMembersPage', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
    mockFetch()
  })

  it('should render page heading', async () => {
    render(<OrgMembersPage />)
    // Title uses organization.orgMembers with {name} param
    await waitFor(() => {
      expect(screen.getByText('Organization Members: test-entity')).toBeInTheDocument()
    })
  })

  it('should display the members table with the admin controls', async () => {
    mockFetch(members, 'admin')
    render(<OrgMembersPage />)

    await waitFor(() => {
      expect(screen.getByText('admin-user')).toBeInTheDocument()
    })
    expect(screen.getByText('Add Member')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('should show empty state when no members', async () => {
    render(<OrgMembersPage />)
    await waitFor(() => {
      expect(screen.getByText('No members')).toBeInTheDocument()
    })
  })

  it('should show a non-admin member the list without the add and remove controls', async () => {
    // Reading the list needs any role, changing it needs admin (kukan#258)
    mockFetch(members, 'editor')
    render(<OrgMembersPage />)

    await waitFor(() => {
      expect(screen.getByText('admin-user')).toBeInTheDocument()
    })
    expect(screen.queryByText('Add Member')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })
})
