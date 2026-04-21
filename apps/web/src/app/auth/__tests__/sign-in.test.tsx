import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { mockSignInEmail } = vi.hoisted(() => ({
  mockSignInEmail: vi.fn(),
}))

vi.mock('@/lib/auth-client', () => ({
  signIn: { email: mockSignInEmail },
}))

vi.mock('@/hooks/use-site-settings', () => ({
  useSiteSettings: () => ({ registrationEnabled: true, loading: false }),
}))

import SignInPage from '../sign-in/page'

describe('SignInPage', () => {
  beforeEach(() => {
    mockSignInEmail.mockReset()
  })

  it('should render sign-in form', () => {
    render(<SignInPage />)
    expect(screen.getAllByText('Sign In').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
  })

  it('should render sign-up link when registration is enabled', () => {
    render(<SignInPage />)
    expect(screen.getByText('Create Account')).toBeInTheDocument()
  })

  it('should show validation errors for empty submission', async () => {
    render(<SignInPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))

    await waitFor(() => {
      expect(screen.getByText('Please enter a valid email address')).toBeInTheDocument()
    })
  })

  it('should call signIn.email on valid submission', async () => {
    mockSignInEmail.mockResolvedValue({ error: null })

    render(<SignInPage />)

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'user@example.com' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password123' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))

    await waitFor(() => {
      expect(mockSignInEmail).toHaveBeenCalledWith({
        email: 'user@example.com',
        password: 'password123',
      })
    })
  })

  it('should show error message on failed sign-in', async () => {
    mockSignInEmail.mockResolvedValue({ error: { message: 'Invalid' } })

    render(<SignInPage />)

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'user@example.com' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password123' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))

    await waitFor(() => {
      expect(screen.getByText('Invalid email or password')).toBeInTheDocument()
    })
  })
})
