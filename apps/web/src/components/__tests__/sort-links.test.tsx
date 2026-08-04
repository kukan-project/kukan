import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SortLinks } from '../sort-links'

describe('SortLinks', () => {
  it('should keep the search query when switching order', () => {
    render(<SortLinks basePath="/organization" params={{ q: 'tokyo' }} active="name" />)

    const byCount = screen.getByText('By dataset count').closest('a')
    expect(byCount).toHaveAttribute('href', '/organization?q=tokyo&orderBy=datasetCount')
  })

  it('should leave the default order out of the link', () => {
    render(<SortLinks basePath="/group" active="datasetCount" />)

    // A bare /group already means identifier order — spelling it out adds noise
    expect(screen.getByText('By URL identifier').closest('a')).toHaveAttribute('href', '/group?')
  })

  it('should mark the active order for assistive tech', () => {
    render(<SortLinks basePath="/group" active="datasetCount" />)

    expect(screen.getByText('By dataset count').closest('a')).toHaveAttribute(
      'aria-current',
      'true'
    )
    expect(screen.getByText('By URL identifier').closest('a')).not.toHaveAttribute('aria-current')
  })
})
