import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import EditOrganizationPage from '../page'

vi.mock('next/navigation', () => ({
  useParams: () => ({ nameOrId: 'test-org' }),
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/components/dashboard/user-provider', () => ({
  useUser: () => ({ id: 'u1', name: 'admin', email: 'a@b.com', sysadmin: true }),
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

  it('should disable delete when active datasets remain', async () => {
    vi.mocked(clientFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'o1', name: 'test-org', title: 'Test', datasetCount: 3 }),
    } as Response)

    render(<EditOrganizationPage />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete Organization' })).toBeDisabled()
    })
    expect(screen.getByText(/3 active dataset/)).toBeInTheDocument()
  })

  it('should enable delete when no active datasets', async () => {
    vi.mocked(clientFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'o1', name: 'test-org', title: 'Test', datasetCount: 0 }),
    } as Response)

    render(<EditOrganizationPage />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete Organization' })).toBeEnabled()
    })
  })

  it('should keep delete disabled when the active count is unknown (fail-safe)', async () => {
    // Response without datasetCount (e.g. a stale cached body) must not enable delete.
    vi.mocked(clientFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'o1', name: 'test-org', title: 'Test' }),
    } as Response)

    render(<EditOrganizationPage />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete Organization' })).toBeDisabled()
    })
  })

  it('should close the dialog after a successful soft-delete (no purge modal)', async () => {
    vi.mocked(clientFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'o1', name: 'test-org', title: 'Test', datasetCount: 0 }),
    } as Response)

    render(<EditOrganizationPage />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete Organization' })).toBeEnabled()
    })

    // Open the confirm dialog and confirm the soft-delete.
    fireEvent.click(screen.getByRole('button', { name: 'Delete Organization' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    // Dialog must close — it must NOT re-render as the purge modal.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByText('Purge Organization')).not.toBeInTheDocument()
  })
})
