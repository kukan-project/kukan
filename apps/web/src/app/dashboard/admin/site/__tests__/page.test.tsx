import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import AdminSitePage from '../page'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockUser = { id: 'u1', name: 'admin', email: 'admin@test.com', sysadmin: true }
vi.mock('@/components/dashboard/user-provider', () => ({
  useUser: () => mockUser,
}))

const mockReplace = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: mockReplace, back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

const mockClientFetch = vi.mocked(clientFetch)

function mockFetchResponse(data: unknown) {
  return { ok: true, json: async () => data } as Response
}

describe('AdminSitePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUser.sysadmin = true
  })

  it('renders the page title', () => {
    render(<AdminSitePage />)
    expect(screen.getByText('Site Management')).toBeInTheDocument()
  })

  it('redirects non-sysadmin users', () => {
    mockUser.sysadmin = false
    const { container } = render(<AdminSitePage />)
    expect(container.innerHTML).toBe('')
  })

  it('renders the data reset card with warning', () => {
    render(<AdminSitePage />)
    expect(screen.getByText('Data Reset')).toBeInTheDocument()
    expect(
      screen.getByText(
        'This will permanently delete all datasets, resources, organizations, groups, tags, pipeline jobs, and associated files. User accounts will be preserved.'
      )
    ).toBeInTheDocument()
  })

  it('has confirm input and disabled button by default', () => {
    render(<AdminSitePage />)
    const input = screen.getByPlaceholderText('RESET')
    expect(input).toBeInTheDocument()

    const button = screen.getByRole('button', { name: /Delete All Data/ })
    expect(button).toBeDisabled()
  })

  it('enables button when RESET is typed', () => {
    render(<AdminSitePage />)
    const input = screen.getByPlaceholderText('RESET')
    fireEvent.change(input, { target: { value: 'RESET' } })

    const button = screen.getByRole('button', { name: /Delete All Data/ })
    expect(button).toBeEnabled()
  })

  it('shows result after successful reset', async () => {
    mockClientFetch.mockResolvedValue(
      mockFetchResponse({
        deleted: {
          packages: 5,
          organizations: 2,
          groups: 3,
          tags: 10,
          storageObjects: 8,
        },
      })
    )

    render(<AdminSitePage />)
    const input = screen.getByPlaceholderText('RESET')
    fireEvent.change(input, { target: { value: 'RESET' } })

    const button = screen.getByRole('button', { name: /Delete All Data/ })
    fireEvent.click(button)

    await waitFor(() => {
      expect(screen.getByText('Reset Complete')).toBeInTheDocument()
    })
  })

  it('shows error on failed reset', async () => {
    mockClientFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as Response)

    render(<AdminSitePage />)
    const input = screen.getByPlaceholderText('RESET')
    fireEvent.change(input, { target: { value: 'RESET' } })

    const button = screen.getByRole('button', { name: /Delete All Data/ })
    fireEvent.click(button)

    await waitFor(() => {
      expect(screen.getByText('500: Internal Server Error')).toBeInTheDocument()
    })
  })
})
