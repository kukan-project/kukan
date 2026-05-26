import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import AdminAnalyticsPage from '../page'
import { brandConfig } from '@/brand'

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

describe('AdminAnalyticsPage', () => {
  beforeEach(() => {
    mockUser.sysadmin = true
    brandConfig.gaMeasurementId = null
  })

  it('renders the page title', () => {
    render(<AdminAnalyticsPage />)
    expect(screen.getByText('Access Analytics')).toBeInTheDocument()
  })

  it('redirects non-sysadmin users', () => {
    mockUser.sysadmin = false
    const { container } = render(<AdminAnalyticsPage />)
    expect(container.innerHTML).toBe('')
  })

  it('shows setup instructions when GA4 is not configured', () => {
    render(<AdminAnalyticsPage />)
    expect(screen.getByText('GA4 Not Configured')).toBeInTheDocument()
    expect(screen.getByText('Open Google Analytics')).toBeInTheDocument()
  })

  it('shows coming soon message when GA4 is configured', () => {
    brandConfig.gaMeasurementId = 'G-TEST123'
    render(<AdminAnalyticsPage />)
    expect(screen.queryByText('GA4 Not Configured')).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'The analytics dashboard is under development. In the meantime, you can view analytics data in the Google Analytics console.'
      )
    ).toBeInTheDocument()
  })
})
