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

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

/** Routes the organization fetch and the viewer's memberships, which decide
 *  whether the editable form or the read-only view renders */
function mockFetch(org: unknown, role: string | null = 'admin') {
  vi.mocked(clientFetch).mockImplementation(async (url: string) => {
    if (url.startsWith('/api/v1/users/me/organizations')) {
      return jsonResponse({ items: role ? [{ id: 'o1', name: 'test-org', role }] : [] })
    }
    return org as Response
  })
}

describe('EditOrganizationPage', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
  })

  it('should fetch and render form with edit mode', async () => {
    mockFetch(
      jsonResponse({
        id: 'o1',
        name: 'test-org',
        title: 'Test Organization',
        description: 'A test org',
        imageUrl: null,
      })
    )

    render(<EditOrganizationPage />)

    await waitFor(() => {
      expect(screen.getByTestId('organization-form')).toBeInTheDocument()
    })

    const form = screen.getByTestId('organization-form')
    expect(form).toHaveAttribute('data-mode', 'edit')
    expect(form).toHaveAttribute('data-name', 'test-org')
  })

  it.each([
    ['a non-admin member', 'member'],
    ['not a member at all', null],
  ])('should show the organization read-only when the viewer is %s', async (_label, role) => {
    mockFetch(
      jsonResponse({ id: 'o1', name: 'test-org', title: 'Test Organization', datasetCount: 0 }),
      role
    )

    render(<EditOrganizationPage />)

    await waitFor(() => {
      expect(screen.getByText('Test Organization')).toBeInTheDocument()
    })
    // Neither the update button (in the form) nor delete — both need admin
    // and only produced an API error when offered
    expect(screen.queryByTestId('organization-form')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete Organization' })).not.toBeInTheDocument()
    expect(
      screen.getByText('Editing requires the admin role. This is shown for reference only.')
    ).toBeInTheDocument()
  })

  it('should show not found when API returns error', async () => {
    mockFetch(jsonResponse({}, false))

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
    mockFetch(jsonResponse({ id: 'o1', name: 'test-org', title: 'Test', datasetCount: 3 }))

    render(<EditOrganizationPage />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete Organization' })).toBeDisabled()
    })
    expect(screen.getByText(/3 active dataset/)).toBeInTheDocument()
  })

  it('should enable delete when no active datasets', async () => {
    mockFetch(jsonResponse({ id: 'o1', name: 'test-org', title: 'Test', datasetCount: 0 }))

    render(<EditOrganizationPage />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete Organization' })).toBeEnabled()
    })
  })

  it('should keep delete disabled when the active count is unknown (fail-safe)', async () => {
    // Response without datasetCount (e.g. a stale cached body) must not enable delete.
    mockFetch(jsonResponse({ id: 'o1', name: 'test-org', title: 'Test' }))

    render(<EditOrganizationPage />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete Organization' })).toBeDisabled()
    })
  })

  it('should close the dialog after a successful soft-delete (no purge modal)', async () => {
    mockFetch(jsonResponse({ id: 'o1', name: 'test-org', title: 'Test', datasetCount: 0 }))

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
