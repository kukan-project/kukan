import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { UserMenu } from '../user-menu'

vi.mock('@/lib/auth-client', () => ({
  signOut: vi.fn().mockResolvedValue(undefined),
}))

const defaultUser = {
  name: 'john-doe',
  email: 'john@example.com',
  displayName: 'John Doe',
}

describe('UserMenu', () => {
  it('should render avatar with initials from displayName', () => {
    render(<UserMenu user={defaultUser} />)
    expect(screen.getByText('JD')).toBeInTheDocument()
  })

  it('should use name for initials when no displayName', () => {
    render(<UserMenu user={{ ...defaultUser, displayName: null }} />)
    // "john-doe" splits on hyphen -> "j" + "d" -> "JD"
    expect(screen.getByText('JD')).toBeInTheDocument()
  })

  it('should render single-character initial for single-word name', () => {
    render(<UserMenu user={{ ...defaultUser, displayName: 'Alice' }} />)
    expect(screen.getByText('A')).toBeInTheDocument()
  })

  it('should render trigger as a button', () => {
    render(<UserMenu user={defaultUser} />)
    expect(screen.getByRole('button')).toBeInTheDocument()
  })

  it('should truncate initials to two characters', () => {
    render(
      <UserMenu user={{ ...defaultUser, displayName: 'Alice Bob Charlie' }} />
    )
    // ABC truncated to AB
    expect(screen.getByText('AB')).toBeInTheDocument()
  })

  it('should render avatar fallback element', () => {
    const { container } = render(<UserMenu user={defaultUser} />)
    const fallback = container.querySelector('[data-slot="avatar-fallback"]')
    expect(fallback).toBeInTheDocument()
  })
})
