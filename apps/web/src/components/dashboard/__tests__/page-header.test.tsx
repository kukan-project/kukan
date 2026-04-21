import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PageHeader } from '../page-header'

describe('PageHeader', () => {
  it('should render title as h1', () => {
    render(<PageHeader title="Datasets" />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Datasets')
  })

  it('should render children', () => {
    render(
      <PageHeader title="Test">
        <button>Create</button>
      </PageHeader>
    )
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument()
  })

  it('should render without children', () => {
    const { container } = render(<PageHeader title="Solo" />)
    expect(container.querySelector('h1')).toHaveTextContent('Solo')
  })
})
