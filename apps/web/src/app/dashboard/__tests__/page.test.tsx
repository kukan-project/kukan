import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { UserProvider, type DashboardUser } from '@/components/dashboard/user-provider'
import DashboardPage from '../page'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockUser: DashboardUser = {
  id: 'u1',
  name: 'Test User',
  email: 'test@example.com',
  displayName: null,
  sysadmin: false,
}

function mockFetchResponse(data: unknown) {
  return { ok: true, json: async () => data } as Response
}

function renderPage(user = mockUser) {
  return render(
    <UserProvider user={user}>
      <DashboardPage />
    </UserProvider>
  )
}

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
  })

  it('should show loading state initially', () => {
    vi.mocked(clientFetch).mockReturnValue(new Promise(() => {})) // never resolves
    renderPage()
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('should display recent datasets', async () => {
    vi.mocked(clientFetch).mockResolvedValue(
      mockFetchResponse({
        items: [
          { id: '1', name: 'ds-1', title: 'Dataset One', private: false, formats: 'CSV' },
          { id: '2', name: 'ds-2', title: 'Dataset Two', private: false, formats: 'PDF' },
        ],
        total: 2,
      })
    )
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('Dataset One')).toBeInTheDocument()
    })
    expect(screen.getByText('Dataset Two')).toBeInTheDocument()
  })

  it('should show dataset count in card', async () => {
    vi.mocked(clientFetch).mockResolvedValue(
      mockFetchResponse({ items: [{ id: '1', name: 'ds', title: 'D', private: false }], total: 42 })
    )
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('42')).toBeInTheDocument()
    })
  })

  it('should show empty state with create button', async () => {
    vi.mocked(clientFetch).mockResolvedValue(mockFetchResponse({ items: [], total: 0 }))
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('No datasets')).toBeInTheDocument()
    })
    expect(screen.getByText('Create Dataset')).toBeInTheDocument()
  })

  it('should show private badge for private datasets', async () => {
    vi.mocked(clientFetch).mockResolvedValue(
      mockFetchResponse({
        items: [
          { id: '1', name: 'pub', title: 'Public DS', private: false },
          { id: '2', name: 'priv', title: 'Private DS', private: true },
        ],
        total: 2,
      })
    )
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('Private')).toBeInTheDocument()
    })
  })

  it('should show welcome message with user name', () => {
    vi.mocked(clientFetch).mockReturnValue(new Promise(() => {}))
    renderPage()
    expect(screen.getByText('Welcome, Test User')).toBeInTheDocument()
  })

  it('should link datasets to edit page', async () => {
    vi.mocked(clientFetch).mockResolvedValue(
      mockFetchResponse({
        items: [{ id: '1', name: 'my-ds', title: 'My Dataset', private: false }],
        total: 1,
      })
    )
    renderPage()

    await waitFor(() => {
      const link = screen.getByText('My Dataset').closest('a')
      expect(link).toHaveAttribute('href', '/dashboard/datasets/my-ds/edit')
    })
  })
})
