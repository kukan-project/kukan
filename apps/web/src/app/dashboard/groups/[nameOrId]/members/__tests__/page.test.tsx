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

import GroupMembersPage from '../page'

describe('GroupMembersPage', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
    mockClientFetch.mockResolvedValue(jsonResponse({ items: [] }))
  })

  it('should render page heading', async () => {
    render(<GroupMembersPage />)
    await waitFor(() => {
      expect(screen.getByText('Category Members: test-entity')).toBeInTheDocument()
    })
  })

  it('should display members when loaded', async () => {
    mockClientFetch.mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: 'm1',
            userId: 'u1',
            role: 'member',
            userName: 'test-user',
            email: 'user@test.com',
            created: '2026-01-01',
          },
        ],
      })
    )
    render(<GroupMembersPage />)

    await waitFor(() => {
      expect(screen.getByText('test-user')).toBeInTheDocument()
    })
  })

  it('should show empty state when no members', async () => {
    render(<GroupMembersPage />)
    await waitFor(() => {
      expect(screen.getByText('No members')).toBeInTheDocument()
    })
  })
})
