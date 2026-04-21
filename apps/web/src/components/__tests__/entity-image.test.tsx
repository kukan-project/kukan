import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EntityImage } from '../entity-image'

describe('EntityImage', () => {
  it('should render img when imageUrl is provided', () => {
    render(<EntityImage imageUrl="https://example.com/logo.png" name="Test Org" />)
    const img = screen.getByRole('img', { name: 'Test Org' })
    expect(img).toHaveAttribute('src', 'https://example.com/logo.png')
  })

  it('should render uppercase initial when no imageUrl', () => {
    render(<EntityImage name="test org" />)
    expect(screen.getByText('T')).toBeInTheDocument()
  })

  it('should render uppercase initial when imageUrl is null', () => {
    render(<EntityImage imageUrl={null} name="demo" />)
    expect(screen.getByText('D')).toBeInTheDocument()
  })
})
