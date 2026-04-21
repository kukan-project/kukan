import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FormatBadges } from '../format-badges'

describe('FormatBadges', () => {
  it('should return null for undefined formats', () => {
    const { container } = render(<FormatBadges formats={undefined} />)
    expect(container.innerHTML).toBe('')
  })

  it('should return null for empty string', () => {
    const { container } = render(<FormatBadges formats="" />)
    expect(container.innerHTML).toBe('')
  })

  it('should render multiple badges from comma-separated string', () => {
    render(<FormatBadges formats="CSV,JSON,PDF" />)
    expect(screen.getByText('CSV')).toBeInTheDocument()
    expect(screen.getByText('JSON')).toBeInTheDocument()
    expect(screen.getByText('PDF')).toBeInTheDocument()
  })

  it('should filter empty segments from trailing commas', () => {
    render(<FormatBadges formats="CSV,,JSON," />)
    expect(screen.getByText('CSV')).toBeInTheDocument()
    expect(screen.getByText('JSON')).toBeInTheDocument()
    expect(screen.getAllByText(/./)).toHaveLength(2)
  })
})
