import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { Footer } from '../layout/footer'

// Pin the brand layer to KUKAN defaults so fork customizations don't break body tests (ADR-023)
vi.mock('@/brand', () => import('@/__tests__/brand-defaults'))
vi.mock('@/brand/brand-config', () => import('@/__tests__/brand-defaults'))

function renderFooter(locale: string) {
  return render(
    <NextIntlClientProvider locale={locale}>
      <Footer />
    </NextIntlClientProvider>
  )
}

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

  it('should show the footer link label for the ja locale', () => {
    renderFooter('ja')
    expect(screen.getByRole('link', { name: '利用規約' })).toHaveAttribute('href', '/terms')
  })

  it('should show the footer link label for the en locale', () => {
    renderFooter('en')
    expect(screen.getByRole('link', { name: 'Terms of Use' })).toHaveAttribute('href', '/terms')
  })
})
