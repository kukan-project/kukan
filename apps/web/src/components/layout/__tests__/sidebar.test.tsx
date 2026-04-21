import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Sidebar } from '../sidebar'

const mockUseUser = vi.fn()

vi.mock('@/components/dashboard/user-provider', () => ({
  useUser: () => mockUseUser(),
}))

describe('Sidebar', () => {
  it('should render standard nav items', () => {
    mockUseUser.mockReturnValue({ sysadmin: false })
    render(<Sidebar />)
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Dataset Management')).toBeInTheDocument()
    expect(screen.getByText('Organization Management')).toBeInTheDocument()
    expect(screen.getByText('Category Management')).toBeInTheDocument()
  })

  it('should show admin section for sysadmin', () => {
    mockUseUser.mockReturnValue({ sysadmin: true })
    render(<Sidebar />)
    expect(screen.getByText('System Admin')).toBeInTheDocument()
    expect(screen.getByText('Users')).toBeInTheDocument()
    expect(screen.getByText('Job Management')).toBeInTheDocument()
    expect(screen.getByText('Health Check')).toBeInTheDocument()
    expect(screen.getByText('Index Management')).toBeInTheDocument()
    expect(screen.getByText('Site Management')).toBeInTheDocument()
  })

  it('should hide admin section for non-sysadmin', () => {
    mockUseUser.mockReturnValue({ sysadmin: false })
    render(<Sidebar />)
    expect(screen.queryByText('System Admin')).not.toBeInTheDocument()
    expect(screen.queryByText('Users')).not.toBeInTheDocument()
  })

  it('should render nav links with correct hrefs', () => {
    mockUseUser.mockReturnValue({ sysadmin: false })
    render(<Sidebar />)
    expect(screen.getByText('Dashboard').closest('a')).toHaveAttribute('href', '/dashboard')
    expect(screen.getByText('Dataset Management').closest('a')).toHaveAttribute(
      'href',
      '/dashboard/datasets'
    )
  })

  it('should render admin links with correct hrefs', () => {
    mockUseUser.mockReturnValue({ sysadmin: true })
    render(<Sidebar />)
    expect(screen.getByText('Users').closest('a')).toHaveAttribute('href', '/dashboard/admin/users')
    expect(screen.getByText('Job Management').closest('a')).toHaveAttribute(
      'href',
      '/dashboard/admin/jobs'
    )
  })
})
