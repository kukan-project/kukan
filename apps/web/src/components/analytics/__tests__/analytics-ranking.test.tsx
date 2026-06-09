import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AnalyticsRanking } from '../analytics-ranking'

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

describe('AnalyticsRanking', () => {
  const defaultProps = {
    items: [] as { label: string; value: number; href?: string }[],
    loading: false,
    error: null,
    labelHeader: 'Name',
    valueHeader: 'Views',
    offset: 0,
    total: 0,
    pageSize: 20,
    totalPages: 0,
    currentPage: 1,
    onPageChange: vi.fn(),
  }

  it('shows loading skeletons when loading', () => {
    const { container } = render(<AnalyticsRanking {...defaultProps} loading={true} />)
    // 5 skeleton elements
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons).toHaveLength(5)
  })

  it('shows no data message when items are empty', () => {
    render(<AnalyticsRanking {...defaultProps} />)
    expect(screen.getByText('No analytics data for this period')).toBeInTheDocument()
  })

  it('shows error message on error', () => {
    render(<AnalyticsRanking {...defaultProps} error={new Error('HTTP 500')} />)
    expect(screen.getByText('HTTP 500')).toBeInTheDocument()
  })

  it('renders table with correct headers', () => {
    render(
      <AnalyticsRanking
        {...defaultProps}
        items={[{ label: 'test', value: 42 }]}
        total={1}
        totalPages={1}
      />
    )
    expect(screen.getByText('#')).toBeInTheDocument()
    expect(screen.getByText('Name')).toBeInTheDocument()
    expect(screen.getByText('Views')).toBeInTheDocument()
  })

  it('renders items with rank numbers', () => {
    render(
      <AnalyticsRanking
        {...defaultProps}
        items={[
          { label: 'first', value: 100 },
          { label: 'second', value: 50 },
        ]}
        total={2}
        totalPages={1}
      />
    )
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('first')).toBeInTheDocument()
    expect(screen.getByText('second')).toBeInTheDocument()
  })

  it('calculates rank from offset', () => {
    render(
      <AnalyticsRanking
        {...defaultProps}
        items={[{ label: 'item', value: 10 }]}
        offset={20}
        total={21}
        totalPages={2}
        currentPage={2}
      />
    )
    expect(screen.getByText('21')).toBeInTheDocument()
  })

  it('renders links for items with href', () => {
    render(
      <AnalyticsRanking
        {...defaultProps}
        items={[{ label: 'my-dataset', value: 100, href: '/dataset/my-dataset' }]}
        total={1}
        totalPages={1}
      />
    )
    const link = screen.getByRole('link', { name: 'my-dataset' })
    expect(link).toHaveAttribute('href', '/dataset/my-dataset')
  })

  it('renders plain text for items without href', () => {
    render(
      <AnalyticsRanking
        {...defaultProps}
        items={[{ label: 'plain-item', value: 50 }]}
        total={1}
        totalPages={1}
      />
    )
    expect(screen.getByText('plain-item')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'plain-item' })).not.toBeInTheDocument()
  })

  it('formats numbers with locale', () => {
    render(
      <AnalyticsRanking
        {...defaultProps}
        items={[{ label: 'popular', value: 1234567 }]}
        total={1}
        totalPages={1}
      />
    )
    // toLocaleString() output varies by locale, but should contain the digits
    expect(screen.getByText(/1.*234.*567/)).toBeInTheDocument()
  })
})
