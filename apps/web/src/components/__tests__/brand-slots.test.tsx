import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Footer } from '../layout/footer'
import { Header } from '../layout/header'
import HomePage from '@/app/page'

// Verify the ADR-023 slot mechanism: when a fork registers an override,
// the slot component renders it instead of the default implementation.
vi.mock('@/brand', async () => {
  const { createElement } = await import('react')
  const defaults = await import('@/__tests__/brand-defaults')
  return {
    ...defaults,
    overrides: {
      Header: () => createElement('div', null, 'custom-brand-header'),
      Footer: () => createElement('div', null, 'custom-brand-footer'),
      TopPage: () => createElement('div', null, 'custom-brand-top-page'),
    },
  }
})

vi.mock('@/lib/server-api', () => ({
  serverFetch: vi.fn(),
  getCurrentUser: vi.fn(async () => null),
}))

describe('Brand override slots', () => {
  it('should render the Header override instead of the default', async () => {
    render(await Header())
    expect(screen.getByText('custom-brand-header')).toBeInTheDocument()
  })

  it('should render the Footer override instead of the default', () => {
    render(<Footer />)
    expect(screen.getByText('custom-brand-footer')).toBeInTheDocument()
    expect(screen.queryByText('KUKAN')).not.toBeInTheDocument()
  })

  it('should render the TopPage override instead of the default', async () => {
    render(await HomePage())
    expect(screen.getByText('custom-brand-top-page')).toBeInTheDocument()
  })
})
