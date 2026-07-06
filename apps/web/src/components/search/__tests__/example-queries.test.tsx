import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { brandConfig } from '@/brand'
import { ExampleQueries } from '../example-queries'

vi.mock('@/brand', () => ({
  brandConfig: { searchExampleQueries: [] as string[] },
}))

describe('ExampleQueries', () => {
  it('should render nothing when no example queries are configured', () => {
    brandConfig.searchExampleQueries = []
    const { container } = render(<ExampleQueries />)
    expect(container).toBeEmptyDOMElement()
  })

  it('should render a chip linking to the dataset search for each query', () => {
    brandConfig.searchExampleQueries = ['避難所の場所', '無料Wi-Fiが使える場所']
    render(<ExampleQueries />)

    expect(screen.getByText('Try:')).toBeInTheDocument()
    const link = screen.getByText('避難所の場所').closest('a')
    expect(link).toHaveAttribute('href', `/dataset?q=${encodeURIComponent('避難所の場所')}`)
    expect(screen.getByText('無料Wi-Fiが使える場所')).toBeInTheDocument()
  })
})
