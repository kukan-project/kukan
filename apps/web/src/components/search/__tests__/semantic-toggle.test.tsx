import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SemanticToggle } from '../semantic-toggle'

// Override useSearchParams / capture router.push per test
const mockSearchParams = vi.fn(() => new URLSearchParams())
const mockPush = vi.fn()

vi.mock('next/navigation', async () => {
  const actual = await vi.importActual('next/navigation')
  return {
    ...actual,
    useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn() }),
    useSearchParams: () => mockSearchParams(),
  }
})

beforeEach(() => {
  mockSearchParams.mockReturnValue(new URLSearchParams())
  mockPush.mockReset()
})

describe('SemanticToggle', () => {
  it('should render nothing while browsing (no query)', () => {
    const { container } = render(<SemanticToggle semanticEnabled={true} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('should render an enabled switch for keyword queries', () => {
    mockSearchParams.mockReturnValue(new URLSearchParams('q=test'))
    render(<SemanticToggle semanticEnabled={true} />)
    expect(screen.getByRole('switch')).toBeChecked()
  })

  it('should render nothing when semantic search is disabled site-wide', () => {
    mockSearchParams.mockReturnValue(new URLSearchParams('q=test'))
    const { container } = render(<SemanticToggle semanticEnabled={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('should keep the toggle visible while settings are still loading', () => {
    mockSearchParams.mockReturnValue(new URLSearchParams('q=test'))
    render(<SemanticToggle semanticEnabled={null} />)
    expect(screen.getByRole('switch')).toBeInTheDocument()
  })

  it('should reflect semantic=false as unchecked', () => {
    mockSearchParams.mockReturnValue(new URLSearchParams('q=test&semantic=false'))
    render(<SemanticToggle semanticEnabled={true} />)
    expect(screen.getByRole('switch')).not.toBeChecked()
  })

  it('should set semantic=false and reset offset when turned off', () => {
    mockSearchParams.mockReturnValue(new URLSearchParams('q=test&offset=20'))
    render(<SemanticToggle semanticEnabled={true} />)
    fireEvent.click(screen.getByRole('switch'))

    expect(mockPush).toHaveBeenCalledTimes(1)
    const url = new URL(mockPush.mock.calls[0][0], 'http://localhost')
    expect(url.searchParams.get('semantic')).toBe('false')
    expect(url.searchParams.has('offset')).toBe(false)
  })

  it('should drop the semantic param when turned back on', () => {
    mockSearchParams.mockReturnValue(new URLSearchParams('q=test&semantic=false'))
    render(<SemanticToggle semanticEnabled={true} />)
    fireEvent.click(screen.getByRole('switch'))

    const url = new URL(mockPush.mock.calls[0][0], 'http://localhost')
    expect(url.searchParams.has('semantic')).toBe(false)
    expect(url.searchParams.get('q')).toBe('test')
  })
})
