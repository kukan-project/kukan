import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { changePassword } from '@/lib/auth-client'
import { PasswordChangeCard } from '../password-change-card'

vi.mock('@/lib/auth-client', () => ({ changePassword: vi.fn() }))
const mockChangePassword = vi.mocked(changePassword)

vi.mock('@/components/dashboard/user-provider', () => ({
  useUser: () => ({
    id: 'u1',
    name: 'testuser',
    email: 'test@example.com',
    displayName: 'Test User',
    sysadmin: false,
  }),
}))

const STRONG = 'harbor-lantern-quiet-42'

function fill({ current = 'the-old-passphrase', next = STRONG, confirm = STRONG } = {}) {
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: current } })
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: next } })
  fireEvent.change(screen.getByLabelText('New password (confirm)'), {
    target: { value: confirm },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
}

describe('PasswordChangeCard', () => {
  beforeEach(() => mockChangePassword.mockReset())

  it('revokes other sessions when changing the password', async () => {
    mockChangePassword.mockResolvedValue({ data: { token: 't' }, error: null } as never)
    render(<PasswordChangeCard />)
    fill()

    await waitFor(() =>
      expect(mockChangePassword).toHaveBeenCalledWith({
        currentPassword: 'the-old-passphrase',
        newPassword: STRONG,
        revokeOtherSessions: true,
      })
    )
  })

  it('announces success as a polite status, not an alert', async () => {
    mockChangePassword.mockResolvedValue({ data: { token: 't' }, error: null } as never)
    render(<PasswordChangeCard />)
    fill()

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Password changed.'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reports a wrong current password as an alert', async () => {
    mockChangePassword.mockResolvedValue({
      data: null,
      error: { code: 'INVALID_PASSWORD', message: 'Invalid password' },
    } as never)
    render(<PasswordChangeCard />)
    fill()

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Current password is incorrect')
    )
  })

  it('falls back to a generic message for other failures', async () => {
    mockChangePassword.mockResolvedValue({
      data: null,
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'boom' },
    } as never)
    render(<PasswordChangeCard />)
    fill()

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to change the password')
    )
  })

  it('rejects a mismatched confirmation before calling the API', async () => {
    render(<PasswordChangeCard />)
    fill({ confirm: 'different-one' })

    await waitFor(() => expect(screen.getByText('Passwords do not match')).toBeInTheDocument())
    expect(mockChangePassword).not.toHaveBeenCalled()
  })

  it('rejects reusing the current password before calling the API', async () => {
    render(<PasswordChangeCard />)
    fill({ next: 'the-old-passphrase', confirm: 'the-old-passphrase' })

    await waitFor(() =>
      expect(screen.getByText('New password must differ from the current one')).toBeInTheDocument()
    )
    expect(mockChangePassword).not.toHaveBeenCalled()
  })

  it('names the bound the message is about, not whichever came first', async () => {
    render(<PasswordChangeCard />)
    fill({ next: 'x'.repeat(200), confirm: 'x'.repeat(200) })

    await waitFor(() =>
      expect(screen.getAllByText('Use at most 128 characters').length).toBeGreaterThan(0)
    )
    expect(mockChangePassword).not.toHaveBeenCalled()
  })

  it('reports a password the server rejects as too weak', async () => {
    mockChangePassword.mockResolvedValue({
      data: null,
      error: { code: 'PASSWORD_TOO_WEAK', message: 'Password is too easy to guess' },
    } as never)
    render(<PasswordChangeCard />)
    fill()

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('too easy to guess'))
  })
})
