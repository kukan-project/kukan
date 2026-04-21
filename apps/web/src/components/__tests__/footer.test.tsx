import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Footer } from '../layout/footer'

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
