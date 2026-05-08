import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import EditOrganizationPage from '../page'

vi.mock('next/navigation', () => ({
  useParams: () => ({ nameOrId: 'test-org' }),
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

vi.mock('@/components/dashboard/organization/organization-form', () => ({
  OrganizationForm: (props: { mode: string; nameOrId: string }) => (
    <div data-testid="organization-form" data-mode={props.mode} data-name={props.nameOrId}>
      OrganizationForm
    </div>
  ),
}))

describe('EditOrganizationPage', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
  })

  it('should fetch and render form with edit mode', async () => {
    vi.mocked(clientFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'o1',
        name: 'test-org',
        title: 'Test Organization',
        description: 'A test org',
        imageUrl: null,
      }),
    } as Response)

    render(<EditOrganizationPage />)

    await waitFor(() => {
      expect(screen.getByTestId('organization-form')).toBeInTheDocument()
    })

    const form = screen.getByTestId('organization-form')
    expect(form).toHaveAttribute('data-mode', 'edit')
    expect(form).toHaveAttribute('data-name', 'test-org')
  })

  it('should show not found when API returns error', async () => {
    vi.mocked(clientFetch).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response)

    render(<EditOrganizationPage />)

    await waitFor(() => {
      expect(screen.getByText('Not found')).toBeInTheDocument()
    })
  })

  it('should show loading state initially', () => {
    vi.mocked(clientFetch).mockReturnValue(new Promise(() => {}))

    render(<EditOrganizationPage />)

    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })
})
