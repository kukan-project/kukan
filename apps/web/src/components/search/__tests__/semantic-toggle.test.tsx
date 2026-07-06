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
    const { container } = render(<SemanticToggle />)
    expect(container).toBeEmptyDOMElement()
  })

  it('should render an enabled switch for keyword queries', () => {
    mockSearchParams.mockReturnValue(new URLSearchParams('q=test'))
    render(<SemanticToggle />)
    expect(screen.getByRole('switch')).toBeChecked()
  })

  it('should reflect semantic=false as unchecked', () => {
    mockSearchParams.mockReturnValue(new URLSearchParams('q=test&semantic=false'))
    render(<SemanticToggle />)
    expect(screen.getByRole('switch')).not.toBeChecked()
  })

  it('should set semantic=false and reset offset when turned off', () => {
    mockSearchParams.mockReturnValue(new URLSearchParams('q=test&offset=20'))
    render(<SemanticToggle />)
    fireEvent.click(screen.getByRole('switch'))

    expect(mockPush).toHaveBeenCalledTimes(1)
    const url = new URL(mockPush.mock.calls[0][0], 'http://localhost')
    expect(url.searchParams.get('semantic')).toBe('false')
    expect(url.searchParams.has('offset')).toBe(false)
  })

  it('should drop the semantic param when turned back on', () => {
    mockSearchParams.mockReturnValue(new URLSearchParams('q=test&semantic=false'))
    render(<SemanticToggle />)
    fireEvent.click(screen.getByRole('switch'))

    const url = new URL(mockPush.mock.calls[0][0], 'http://localhost')
    expect(url.searchParams.has('semantic')).toBe(false)
    expect(url.searchParams.get('q')).toBe('test')
  })
})
