import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/components/dashboard/user-provider', () => ({
  useUser: vi.fn(),
}))

vi.mock('@/components/dashboard/organization/organization-form', () => ({
  OrganizationForm: () => <div data-testid="organization-form">OrganizationForm</div>,
}))

import { useUser } from '@/components/dashboard/user-provider'
import NewOrganizationPage from '../page'

const mockUseUser = vi.mocked(useUser)

describe('NewOrganizationPage', () => {
  it('should render page title for sysadmin', () => {
    mockUseUser.mockReturnValue({ id: 'u1', name: 'admin', sysadmin: true } as ReturnType<
      typeof useUser
    >)
    render(<NewOrganizationPage />)
    expect(screen.getByText('Create Organization')).toBeInTheDocument()
  })

  it('should render OrganizationForm for sysadmin', () => {
    mockUseUser.mockReturnValue({ id: 'u1', name: 'admin', sysadmin: true } as ReturnType<
      typeof useUser
    >)
    render(<NewOrganizationPage />)
    expect(screen.getByTestId('organization-form')).toBeInTheDocument()
  })

  it('should return null for non-sysadmin', () => {
    mockUseUser.mockReturnValue({ id: 'u2', name: 'user', sysadmin: false } as ReturnType<
      typeof useUser
    >)
    const { container } = render(<NewOrganizationPage />)
    expect(container.innerHTML).toBe('')
  })
})
