import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PaginationNav } from '../pagination-nav'

describe('PaginationNav', () => {
  it('should not render when totalPages <= 1', () => {
    const { container } = render(
      <PaginationNav basePath="/dataset" offset={0} limit={20} total={10} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('should show page info', () => {
    render(<PaginationNav basePath="/dataset" offset={0} limit={20} total={100} />)
    expect(screen.getByText('1 / 5')).toBeInTheDocument()
  })

  it('should not show previous button on first page', () => {
    render(<PaginationNav basePath="/dataset" offset={0} limit={20} total={100} />)
    expect(screen.queryByText('前へ')).not.toBeInTheDocument()
    expect(screen.getByText('次へ')).toBeInTheDocument()
  })

  it('should show previous button when offset > 0', () => {
    render(<PaginationNav basePath="/dataset" offset={20} limit={20} total={100} />)
    expect(screen.getByText('前へ')).toBeInTheDocument()
  })

  it('should not show next button on last page', () => {
    render(<PaginationNav basePath="/dataset" offset={80} limit={20} total={100} />)
    expect(screen.getByText('前へ')).toBeInTheDocument()
    expect(screen.queryByText('次へ')).not.toBeInTheDocument()
  })

  it('should show both buttons on middle page', () => {
    render(<PaginationNav basePath="/dataset" offset={40} limit={20} total={100} />)
    expect(screen.getByText('前へ')).toBeInTheDocument()
    expect(screen.getByText('次へ')).toBeInTheDocument()
    expect(screen.getByText('3 / 5')).toBeInTheDocument()
  })

  it('should include query params in href', () => {
    render(
      <PaginationNav basePath="/search" params={{ q: 'test' }} offset={20} limit={20} total={100} />
    )
    const prevLink = screen.getByText('前へ').closest('a')
    expect(prevLink).toHaveAttribute('href', expect.stringContaining('q=test'))
  })
})
