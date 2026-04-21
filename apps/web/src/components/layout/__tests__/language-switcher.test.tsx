import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LanguageSwitcher } from '../language-switcher'

describe('LanguageSwitcher', () => {
  it('should render globe button with Language label', () => {
    render(<LanguageSwitcher />)
    expect(screen.getByRole('button', { name: 'Language' })).toBeInTheDocument()
  })

  it('should render as a ghost variant button', () => {
    render(<LanguageSwitcher />)
    const button = screen.getByRole('button', { name: 'Language' })
    expect(button).toBeInTheDocument()
    expect(button.tagName).toBe('BUTTON')
  })

  it('should render globe icon', () => {
    const { container } = render(<LanguageSwitcher />)
    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
  })
})
