import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { KeyValueTable, extrasToRows } from '../key-value-table'

describe('KeyValueTable', () => {
  it('should render rows with label and value', () => {
    const rows = [
      { label: 'Author', value: 'Alice' },
      { label: 'License', value: 'MIT' },
    ]
    render(<KeyValueTable rows={rows} />)
    expect(screen.getByText('Author')).toBeInTheDocument()
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('License')).toBeInTheDocument()
    expect(screen.getByText('MIT')).toBeInTheDocument()
  })

  it('should return null for empty rows', () => {
    const { container } = render(<KeyValueTable rows={[]} />)
    expect(container.innerHTML).toBe('')
  })

  it('should filter rows with falsy values', () => {
    const rows = [
      { label: 'Author', value: 'Alice' },
      { label: 'Empty', value: '' },
      { label: 'Null', value: null as unknown as string },
    ]
    render(<KeyValueTable rows={rows} />)
    expect(screen.getByText('Author')).toBeInTheDocument()
    expect(screen.queryByText('Empty')).not.toBeInTheDocument()
    expect(screen.queryByText('Null')).not.toBeInTheDocument()
  })
})

describe('extrasToRows', () => {
  it('should return empty array for null', () => {
    expect(extrasToRows(null)).toEqual([])
  })

  it('should convert object to rows filtering null and empty values', () => {
    const extras = { author: 'Alice', empty: '', nothing: null, count: 42 }
    const rows = extrasToRows(extras)
    expect(rows).toEqual([
      { label: 'author', value: 'Alice' },
      { label: 'count', value: '42' },
    ])
  })
})
