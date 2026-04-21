import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FormatBadge } from '../format-badge'

describe('FormatBadge', () => {
  it('should render the format text', () => {
    render(<FormatBadge format="CSV" />)
    expect(screen.getByText('CSV')).toBeInTheDocument()
  })

  it('should apply color class for known format', () => {
    render(<FormatBadge format="csv" />)
    const badge = screen.getByText('csv')
    expect(badge).toHaveClass('bg-green-600')
  })

  it('should apply default color class for unknown format', () => {
    render(<FormatBadge format="xyz" />)
    const badge = screen.getByText('xyz')
    expect(badge).toHaveClass('bg-gray-500')
  })

  it('should apply additional className', () => {
    render(<FormatBadge format="json" className="ml-2" />)
    const badge = screen.getByText('json')
    expect(badge).toHaveClass('ml-2')
  })
})
