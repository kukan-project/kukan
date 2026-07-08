import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ExampleQueries } from '../example-queries'

describe('ExampleQueries', () => {
  it('should render nothing when no example queries are configured', () => {
    const { container } = render(<ExampleQueries queries={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('should render a chip linking to the dataset search for each query', () => {
    render(<ExampleQueries queries={['避難所の場所', '無料Wi-Fiが使える場所']} />)

    expect(screen.getByText('Try:')).toBeInTheDocument()
    const link = screen.getByText('避難所の場所').closest('a')
    expect(link).toHaveAttribute('href', `/dataset?q=${encodeURIComponent('避難所の場所')}`)
    expect(screen.getByText('無料Wi-Fiが使える場所')).toBeInTheDocument()
  })
})
