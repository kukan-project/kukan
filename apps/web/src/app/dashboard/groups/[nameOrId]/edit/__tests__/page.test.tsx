import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import EditGroupPage from '../page'

vi.mock('next/navigation', () => ({
  useParams: () => ({ nameOrId: 'test-group' }),
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

vi.mock('@/components/dashboard/group/group-form', () => ({
  GroupForm: (props: { mode: string; nameOrId: string }) => (
    <div data-testid="group-form" data-mode={props.mode} data-name={props.nameOrId}>
      GroupForm
    </div>
  ),
}))

describe('EditGroupPage', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
  })

  it('should fetch and render form with edit mode', async () => {
    vi.mocked(clientFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'g1',
        name: 'test-group',
        title: 'Test Category',
        description: 'A test category',
        imageUrl: null,
      }),
    } as Response)

    render(<EditGroupPage />)

    await waitFor(() => {
      expect(screen.getByTestId('group-form')).toBeInTheDocument()
    })

    const form = screen.getByTestId('group-form')
    expect(form).toHaveAttribute('data-mode', 'edit')
    expect(form).toHaveAttribute('data-name', 'test-group')
  })

  it('should show not found when API returns error', async () => {
    vi.mocked(clientFetch).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response)

    render(<EditGroupPage />)

    await waitFor(() => {
      expect(screen.getByText('Not found')).toBeInTheDocument()
    })
  })

  it('should show loading state initially', () => {
    vi.mocked(clientFetch).mockReturnValue(new Promise(() => {}))

    render(<EditGroupPage />)

    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })
})
