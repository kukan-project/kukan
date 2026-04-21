import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StatCard } from '../stat-card'

describe('StatCard', () => {
  it('should render label and value', () => {
    render(<StatCard label="Total" value={42} />)
    expect(screen.getByText('Total')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
  })

  it('should show dash when value is undefined', () => {
    render(<StatCard label="Empty" />)
    expect(screen.getByText('-')).toBeInTheDocument()
  })

  it('should handle click', () => {
    const onClick = vi.fn()
    render(<StatCard label="Clickable" value={10} onClick={onClick} />)
    fireEvent.click(screen.getByText('10').closest('[class*="cursor-pointer"]')!)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('should apply active styling when active', () => {
    const { container } = render(<StatCard label="Active" value={5} active />)
    const card = container.firstChild as HTMLElement
    expect(card.className).toContain('border-primary')
  })

  it('should apply destructive style when variant is destructive and value is truthy', () => {
    render(<StatCard label="Errors" value={3} variant="destructive" />)
    const valueEl = screen.getByText('3')
    expect(valueEl).toHaveClass('text-destructive')
  })
})
