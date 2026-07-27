import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DatasetSort } from '../dataset-sort'

// Override useSearchParams for specific tests
const mockSearchParams = vi.fn(() => new URLSearchParams())

vi.mock('next/navigation', async () => {
  const actual = await vi.importActual('next/navigation')
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
    useSearchParams: () => mockSearchParams(),
  }
})

beforeEach(() => {
  mockSearchParams.mockReturnValue(new URLSearchParams())
})

describe('DatasetSort', () => {
  it('should render sort trigger', () => {
    render(<DatasetSort />)
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

  it('should default to updated:desc when no query', () => {
    render(<DatasetSort />)
    expect(screen.getByText('Last Updated (Newest)')).toBeInTheDocument()
  })

  it('should show relevance when search query is present', () => {
    mockSearchParams.mockReturnValue(new URLSearchParams('q=test'))
    render(<DatasetSort />)
    expect(screen.getByText('Relevance')).toBeInTheDocument()
  })

  it('should show explicit sort when sort_by param is set', () => {
    mockSearchParams.mockReturnValue(new URLSearchParams('sort_by=name&sort_order=asc'))
    render(<DatasetSort />)
    expect(screen.getByText('URL Identifier (A→Z)')).toBeInTheDocument()
  })

  it('should show created desc sort', () => {
    mockSearchParams.mockReturnValue(new URLSearchParams('sort_by=created&sort_order=desc'))
    render(<DatasetSort />)
    expect(screen.getByText('Date Created (Newest)')).toBeInTheDocument()
  })
})
