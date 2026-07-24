import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import AnnouncementsManagePage from '../page'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

function mockFetchResponse(data: unknown) {
  return { ok: true, json: async () => data } as Response
}

const sampleAnnouncements = [
  {
    id: 'a1',
    title: 'System maintenance',
    category: 'maintenance',
    publishedAt: '2020-01-01T00:00:00Z',
    created: '2020-01-01T00:00:00Z',
  },
  {
    id: 'a2',
    title: 'New feature released',
    category: 'release',
    publishedAt: null,
    created: '2020-01-02T00:00:00Z',
  },
]

describe('AnnouncementsManagePage', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
    mockPush.mockClear()
  })

  it('should display announcements in table', async () => {
    vi.mocked(clientFetch).mockResolvedValue(
      mockFetchResponse({ items: sampleAnnouncements, total: 2 })
    )
    render(<AnnouncementsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('System maintenance')).toBeInTheDocument()
    })
    expect(screen.getByText('New feature released')).toBeInTheDocument()
  })

  it('should show empty state when no announcements', async () => {
    vi.mocked(clientFetch).mockResolvedValue(mockFetchResponse({ items: [], total: 0 }))
    render(<AnnouncementsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('No announcements')).toBeInTheDocument()
    })
  })

  it('should show status badges', async () => {
    vi.mocked(clientFetch).mockResolvedValue(
      mockFetchResponse({ items: sampleAnnouncements, total: 2 })
    )
    render(<AnnouncementsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('Published')).toBeInTheDocument()
    })
    expect(screen.getByText('Draft')).toBeInTheDocument()
  })

  it('should show new button linking to create page', async () => {
    vi.mocked(clientFetch).mockResolvedValue(mockFetchResponse({ items: [], total: 0 }))
    render(<AnnouncementsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('No announcements')).toBeInTheDocument()
    })
    const link = screen.getByText('New').closest('a')
    expect(link).toHaveAttribute('href', '/dashboard/admin/announcements/new')
  })

  it('navigates to the edit page on row click', async () => {
    vi.mocked(clientFetch).mockResolvedValue(
      mockFetchResponse({ items: sampleAnnouncements, total: 2 })
    )
    render(<AnnouncementsManagePage />)

    await waitFor(() => expect(screen.getByText('System maintenance')).toBeInTheDocument())
    fireEvent.click(screen.getByText('System maintenance'))
    expect(mockPush).toHaveBeenCalledWith('/dashboard/admin/announcements/a1/edit')
  })

  it('should show error state with retry button on fetch failure', async () => {
    vi.mocked(clientFetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response)
    render(<AnnouncementsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('Failed to load data')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('should fetch with publishedOnly=false', async () => {
    vi.mocked(clientFetch).mockResolvedValue(mockFetchResponse({ items: [], total: 0 }))
    render(<AnnouncementsManagePage />)

    await waitFor(() => {
      const calls = vi.mocked(clientFetch).mock.calls
      expect(
        calls.some(([url]) => typeof url === 'string' && url.includes('publishedOnly=false'))
      ).toBe(true)
    })
  })
})
