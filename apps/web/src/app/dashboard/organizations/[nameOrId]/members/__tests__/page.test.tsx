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

import OrgMembersPage from '../page'

describe('OrgMembersPage', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
    mockClientFetch.mockResolvedValue(jsonResponse({ items: [] }))
  })

  it('should render page heading', async () => {
    render(<OrgMembersPage />)
    // Title uses organization.orgMembers with {name} param
    await waitFor(() => {
      expect(screen.getByText('Organization Members: test-entity')).toBeInTheDocument()
    })
  })

  it('should display members table when members exist', async () => {
    mockClientFetch.mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: 'm1',
            userId: 'u1',
            role: 'admin',
            userName: 'admin-user',
            email: 'admin@test.com',
            created: '2026-01-01',
          },
        ],
      })
    )
    render(<OrgMembersPage />)

    await waitFor(() => {
      expect(screen.getByText('admin-user')).toBeInTheDocument()
    })
  })

  it('should show empty state when no members', async () => {
    render(<OrgMembersPage />)
    await waitFor(() => {
      expect(screen.getByText('No members')).toBeInTheDocument()
    })
  })
})
