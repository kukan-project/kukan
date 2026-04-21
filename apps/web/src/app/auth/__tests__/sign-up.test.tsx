import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { mockSignUpEmail } = vi.hoisted(() => ({
  mockSignUpEmail: vi.fn(),
}))

vi.mock('@/lib/auth-client', () => ({
  signUp: { email: mockSignUpEmail },
}))

let mockRegistrationEnabled: boolean | null = true
vi.mock('@/hooks/use-site-settings', () => ({
  useSiteSettings: () => ({ registrationEnabled: mockRegistrationEnabled, loading: false }),
}))

import SignUpPage from '../sign-up/page'

describe('SignUpPage', () => {
  beforeEach(() => {
    mockSignUpEmail.mockReset()
    mockRegistrationEnabled = true
  })

  it('should render sign-up form when registration is enabled', () => {
    render(<SignUpPage />)
    expect(screen.getAllByText('Create Account').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Username')).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
  })

  it('should show registration disabled message', () => {
    mockRegistrationEnabled = false
    render(<SignUpPage />)
    expect(
      screen.getByText('Registration is currently disabled. Please contact your administrator.')
    ).toBeInTheDocument()
  })

  it('should render nothing while loading settings', () => {
    mockRegistrationEnabled = null
    const { container } = render(<SignUpPage />)
    expect(container.innerHTML).toBe('')
  })

  it('should show validation errors for empty submission', async () => {
    render(<SignUpPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }))

    await waitFor(() => {
      expect(screen.getByText('Please enter a valid email address')).toBeInTheDocument()
    })
  })

  it('should call signUp.email on valid submission', async () => {
    mockSignUpEmail.mockResolvedValue({ error: null })

    render(<SignUpPage />)

    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'testuser' },
    })
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'user@example.com' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password123' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }))

    await waitFor(() => {
      expect(mockSignUpEmail).toHaveBeenCalledWith({
        name: 'testuser',
        email: 'user@example.com',
        password: 'password123',
      })
    })
  })

  it('should show error message on failed sign-up', async () => {
    mockSignUpEmail.mockResolvedValue({ error: { message: 'Exists' } })

    render(<SignUpPage />)

    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'testuser' },
    })
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'user@example.com' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password123' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }))

    await waitFor(() => {
      expect(
        screen.getByText('Registration failed. Please try a different email address.')
      ).toBeInTheDocument()
    })
  })

  it('should show sign-in link', () => {
    render(<SignUpPage />)
    expect(screen.getByText('Sign In')).toBeInTheDocument()
  })
})
