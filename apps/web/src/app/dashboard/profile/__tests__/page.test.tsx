import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const mockUser = {
  id: 'u1',
  name: 'testuser',
  email: 'test@example.com',
  displayName: 'Test User',
  sysadmin: false,
}

vi.mock('@/components/dashboard/user-provider', () => ({
  useUser: () => mockUser,
}))

import ProfilePage from '../page'

describe('ProfilePage', () => {
  it('should render profile title', () => {
    render(<ProfilePage />)
    expect(screen.getByText('Profile')).toBeInTheDocument()
  })

  it('should display username', () => {
    render(<ProfilePage />)
    expect(screen.getByText('testuser')).toBeInTheDocument()
  })

  it('should display email', () => {
    render(<ProfilePage />)
    expect(screen.getByText('test@example.com')).toBeInTheDocument()
  })

  it('should display display name', () => {
    render(<ProfilePage />)
    expect(screen.getByText('Test User')).toBeInTheDocument()
  })

  it('should show user role for non-sysadmin', () => {
    render(<ProfilePage />)
    expect(screen.getByText('User')).toBeInTheDocument()
  })
})
