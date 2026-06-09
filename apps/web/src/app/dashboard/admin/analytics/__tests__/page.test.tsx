import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import AdminAnalyticsPage from '../page'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/hooks/use-paginated-fetch', () => ({
  usePaginatedFetch: vi.fn(),
}))

const mockUsePaginatedFetch = vi.mocked(usePaginatedFetch)
const mockFetchPage = vi.fn()

function mockPaginatedReturn(overrides: Record<string, unknown> = {}) {
  mockUsePaginatedFetch.mockReturnValue({
    items: [],
    total: 0,
    offset: 0,
    loading: true,
    error: null,
    totalPages: 0,
    currentPage: 1,
    fetchPage: mockFetchPage,
    pageSize: 20,
    ...overrides,
  } as ReturnType<typeof usePaginatedFetch>)
}

describe('AdminAnalyticsPage', () => {
  beforeEach(() => {
    mockPaginatedReturn()
  })

  it('shows not configured when API returns 404', () => {
    mockPaginatedReturn({ loading: false, error: new Error('HTTP 404') })

    render(<AdminAnalyticsPage />)
    expect(screen.getByText('GA4 Data API Not Configured')).toBeInTheDocument()
  })

  it('shows dashboard with tabs when configured', () => {
    mockPaginatedReturn({
      items: [{ label: 'test-dataset', value: 42, href: '/dataset/test-dataset' }],
      total: 1,
      loading: false,
      totalPages: 1,
    })

    render(<AdminAnalyticsPage />)
    expect(screen.getByText('Dataset Views')).toBeInTheDocument()
    expect(screen.getByText('Resource Views')).toBeInTheDocument()
    expect(screen.getByText('Downloads')).toBeInTheDocument()
    expect(screen.getByText('Search Terms')).toBeInTheDocument()
    expect(screen.getByText('test-dataset')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
  })

  it('shows no data message when items are empty', () => {
    mockPaginatedReturn({ loading: false })

    render(<AdminAnalyticsPage />)
    expect(screen.getByText('No analytics data for this period')).toBeInTheDocument()
  })

  it('fetches dataset-views by default', () => {
    mockPaginatedReturn({ loading: false })
    render(<AdminAnalyticsPage />)
    const url = mockUsePaginatedFetch.mock.calls[0]?.[0] as string
    expect(url).toContain('/admin/analytics/dataset-views')
  })

  it('renders all four tab triggers', () => {
    mockPaginatedReturn({ loading: false })
    render(<AdminAnalyticsPage />)
    expect(screen.getByRole('tab', { name: 'Dataset Views' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Resource Views' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Downloads' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Search Terms' })).toBeInTheDocument()
  })

  it('includes date range in fetch URL', () => {
    mockPaginatedReturn({ loading: false })
    render(<AdminAnalyticsPage />)
    const url = mockUsePaginatedFetch.mock.calls[0]?.[0] as string
    expect(url).toContain('startDate=30daysAgo')
    expect(url).toContain('endDate=today')
  })

  it('shows data delay notice when configured', () => {
    mockPaginatedReturn({ loading: false })
    render(<AdminAnalyticsPage />)
    expect(screen.getByText('GA4 data may be delayed up to 48 hours')).toBeInTheDocument()
  })
})
