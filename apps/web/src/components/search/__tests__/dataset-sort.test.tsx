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

  // The translation mock resolves nested keys like "sort.updated_desc" as
  // the fallback format "search.sort.updated_desc" because the mock only
  // does single-level lookup within the namespace.
  it('should default to updated:desc when no query', () => {
    render(<DatasetSort />)
    expect(screen.getByText('search.sort.updated_desc')).toBeInTheDocument()
  })

  it('should show relevance when search query is present', () => {
    mockSearchParams.mockReturnValue(new URLSearchParams('q=test'))
    render(<DatasetSort />)
    expect(screen.getByText('search.sort.relevance')).toBeInTheDocument()
  })

  it('should show explicit sort when sort_by param is set', () => {
    mockSearchParams.mockReturnValue(new URLSearchParams('sort_by=name&sort_order=asc'))
    render(<DatasetSort />)
    expect(screen.getByText('search.sort.name_asc')).toBeInTheDocument()
  })

  it('should show created desc sort', () => {
    mockSearchParams.mockReturnValue(new URLSearchParams('sort_by=created&sort_order=desc'))
    render(<DatasetSort />)
    expect(screen.getByText('search.sort.created_desc')).toBeInTheDocument()
  })
})
