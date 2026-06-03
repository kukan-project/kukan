import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import EditAnnouncementPage from '../page'

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'a1' }),
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

vi.mock('@/components/dashboard/announcement/announcement-form', () => ({
  AnnouncementForm: (props: { mode: string; id: string }) => (
    <div data-testid="announcement-form" data-mode={props.mode} data-id={props.id}>
      AnnouncementForm
    </div>
  ),
}))

describe('EditAnnouncementPage', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
  })

  it('should fetch and render form with edit mode', async () => {
    vi.mocked(clientFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'a1',
        title: 'Test Announcement',
        category: 'info',
        link: null,
        publishedAt: null,
      }),
    } as Response)

    render(<EditAnnouncementPage />)

    await waitFor(() => {
      expect(screen.getByTestId('announcement-form')).toBeInTheDocument()
    })

    const form = screen.getByTestId('announcement-form')
    expect(form).toHaveAttribute('data-mode', 'edit')
    expect(form).toHaveAttribute('data-id', 'a1')
  })

  it('should show not found when API returns error', async () => {
    vi.mocked(clientFetch).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response)

    render(<EditAnnouncementPage />)

    await waitFor(() => {
      expect(screen.getByText('Not found')).toBeInTheDocument()
    })
  })

  it('should show loading state initially', () => {
    vi.mocked(clientFetch).mockReturnValue(new Promise(() => {}))

    render(<EditAnnouncementPage />)

    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })
})
