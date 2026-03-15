import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import GroupsManagePage from '../page'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

function mockFetchResponse(data: unknown) {
  return { ok: true, json: async () => data } as Response
}

const sampleGroups = [
  { id: 'g1', name: 'demographics', title: 'Demographics', datasetCount: 12 },
  { id: 'g2', name: 'environment', title: 'Environment', datasetCount: 8 },
]

describe('GroupsManagePage', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
  })

  it('should display groups in table', async () => {
    vi.mocked(clientFetch).mockResolvedValue(mockFetchResponse({ items: sampleGroups, total: 2 }))
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
    vi.mocked(clientFetch).mockResolvedValue(mockFetchResponse({ items: [], total: 0 }))
    render(<GroupsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('No categories')).toBeInTheDocument()
    })
  })

  it('should show pagination when total > pageSize', async () => {
    vi.mocked(clientFetch).mockResolvedValue(mockFetchResponse({ items: sampleGroups, total: 50 }))
    render(<GroupsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('1 / 3')).toBeInTheDocument()
    })
    expect(screen.getByText('Next')).toBeInTheDocument()
  })

  it('should not show pagination when total <= pageSize', async () => {
    vi.mocked(clientFetch).mockResolvedValue(mockFetchResponse({ items: sampleGroups, total: 2 }))
    render(<GroupsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('demographics')).toBeInTheDocument()
    })
    expect(screen.queryByText('Next')).not.toBeInTheDocument()
  })

  it('should show new button', async () => {
    vi.mocked(clientFetch).mockResolvedValue(mockFetchResponse({ items: [], total: 0 }))
    render(<GroupsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('No categories')).toBeInTheDocument()
    })
    expect(screen.getByText('New')).toBeInTheDocument()
    const link = screen.getByText('New').closest('a')
    expect(link).toHaveAttribute('href', '/dashboard/groups/new')
  })

  it('should show error state with retry button on fetch failure', async () => {
    vi.mocked(clientFetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response)
    render(<GroupsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('Failed to load data')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('should link to members and view pages', async () => {
    vi.mocked(clientFetch).mockResolvedValue(mockFetchResponse({ items: sampleGroups, total: 2 }))
    render(<GroupsManagePage />)

    await waitFor(() => {
      const memberLinks = screen.getAllByText('Members')
      const link = memberLinks[0].closest('a')
      expect(link).toHaveAttribute('href', '/dashboard/groups/demographics/members')
    })

    const viewLinks = screen.getAllByText('View')
    const viewLink = viewLinks[0].closest('a')
    expect(viewLink).toHaveAttribute('href', '/group/demographics')
  })
})
