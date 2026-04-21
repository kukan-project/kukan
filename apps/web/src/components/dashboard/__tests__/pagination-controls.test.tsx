import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PaginationControls } from '../pagination-controls'

describe('PaginationControls', () => {
  const defaultProps = {
    offset: 0,
    total: 100,
    pageSize: 20,
    totalPages: 5,
    currentPage: 1,
    onPageChange: vi.fn(),
  }

  it('should render page info', () => {
    render(<PaginationControls {...defaultProps} />)
    expect(screen.getByText('1 / 5')).toBeInTheDocument()
  })

  it('should render Previous and Next buttons', () => {
    render(<PaginationControls {...defaultProps} />)
    expect(screen.getByText('Previous')).toBeInTheDocument()
    expect(screen.getByText('Next')).toBeInTheDocument()
  })

  it('should disable Previous on first page', () => {
    render(<PaginationControls {...defaultProps} />)
    expect(screen.getByText('Previous')).toBeDisabled()
  })

  it('should disable Next on last page', () => {
    render(<PaginationControls {...defaultProps} offset={80} currentPage={5} />)
    expect(screen.getByText('Next')).toBeDisabled()
  })

  it('should enable both buttons on middle page', () => {
    render(<PaginationControls {...defaultProps} offset={40} currentPage={3} />)
    expect(screen.getByText('Previous')).not.toBeDisabled()
    expect(screen.getByText('Next')).not.toBeDisabled()
  })

  it('should call onPageChange with previous offset', () => {
    const onPageChange = vi.fn()
    render(
      <PaginationControls
        {...defaultProps}
        offset={40}
        currentPage={3}
        onPageChange={onPageChange}
      />
    )
    fireEvent.click(screen.getByText('Previous'))
    expect(onPageChange).toHaveBeenCalledWith(20)
  })

  it('should call onPageChange with next offset', () => {
    const onPageChange = vi.fn()
    render(<PaginationControls {...defaultProps} onPageChange={onPageChange} />)
    fireEvent.click(screen.getByText('Next'))
    expect(onPageChange).toHaveBeenCalledWith(20)
  })

  it('should return null when totalPages <= 1', () => {
    const { container } = render(<PaginationControls {...defaultProps} totalPages={1} />)
    expect(container.firstChild).toBeNull()
  })
})
