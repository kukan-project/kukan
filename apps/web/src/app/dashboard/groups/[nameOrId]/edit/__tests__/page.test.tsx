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

const group = {
  id: 'g1',
  name: 'test-group',
  title: 'Test Category',
  description: 'A test category',
  imageUrl: null,
}

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

/** Routes the group fetch and the viewer's memberships, which decide whether
 *  the editable form or the read-only view renders (kukan#258) */
function mockFetch(role: string | null, groupResponse = jsonResponse(group)) {
  vi.mocked(clientFetch).mockImplementation(async (url: string) => {
    if (url.startsWith('/api/v1/users/me/groups')) {
      return jsonResponse({ items: role ? [{ ...group, role }] : [] })
    }
    return groupResponse
  })
}

describe('EditGroupPage', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
  })

  it('should fetch and render form with edit mode', async () => {
    mockFetch('admin')

    render(<EditGroupPage />)

    await waitFor(() => {
      expect(screen.getByTestId('group-form')).toBeInTheDocument()
    })

    const form = screen.getByTestId('group-form')
    expect(form).toHaveAttribute('data-mode', 'edit')
    expect(form).toHaveAttribute('data-name', 'test-group')
  })

  it.each([
    ['a non-admin member', 'member'],
    ['not a member at all', null],
  ])('should show the category read-only when the viewer is %s', async (_label, role) => {
    mockFetch(role)

    render(<EditGroupPage />)

    await waitFor(() => {
      expect(screen.getByText('Test Category')).toBeInTheDocument()
    })
    // The update button lives in the form — offering it only produced a
    // "Requires admin role or higher in this group" error (kukan#258)
    expect(screen.queryByTestId('group-form')).not.toBeInTheDocument()
    expect(
      screen.getByText('Editing requires the admin role. This is shown for reference only.')
    ).toBeInTheDocument()
  })

  it('should show not found when API returns error', async () => {
    mockFetch('admin', jsonResponse({}, false))

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
