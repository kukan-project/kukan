import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Footer } from '../layout/footer'

// Pin the brand layer to KUKAN defaults so fork customizations don't break body tests (ADR-023)
vi.mock('@/brand', () => import('@/__tests__/brand-defaults'))

describe('Footer', () => {
  it('should render KUKAN text', () => {
    render(<Footer />)
    expect(screen.getByText('KUKAN')).toBeInTheDocument()
  })

  it('should show copyright with KUKAN Contributors', () => {
    render(<Footer />)
    expect(screen.getByText(/KUKAN Contributors/)).toBeInTheDocument()
  })

  it('should show AGPL-3.0 License', () => {
    render(<Footer />)
    expect(screen.getByText(/AGPL-3.0 License/)).toBeInTheDocument()
  })
})
