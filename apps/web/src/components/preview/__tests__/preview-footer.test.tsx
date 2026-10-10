import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PreviewFooter } from '../preview-footer'

describe('PreviewFooter', () => {
  /** The three parts of the bar, each found the way a screen reader would. */
  function parts() {
    return {
      prev: screen.getByRole('button', { name: 'Previous' }),
      label: screen.getByText(/Page \d/),
      next: screen.getByRole('button', { name: 'Next' }),
    }
  }

  const before = (a: Element, b: Element) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

  it('puts previous before the page label and next after it', () => {
    // Asserted as document order rather than as text: the buttons are icons and
    // contribute no text, so comparing the bar's textContent would pass with
    // the controls on either side — which is the drift this bar was written
    // twice and disagreed about.
    render(<PreviewFooter summary="全 288 行" page={0} totalPages={3} onPageChange={vi.fn()} />)

    const { prev, label, next } = parts()
    expect(before(prev, label)).toBe(true)
    expect(before(label, next)).toBe(true)
  })

  it('shows nothing to page with when there is one page', () => {
    render(<PreviewFooter summary="全 3 行" page={0} totalPages={1} onPageChange={vi.fn()} />)

    expect(screen.getByText('全 3 行')).toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('turns the page in both directions', () => {
    const onPageChange = vi.fn()
    render(
      <PreviewFooter summary="全 288 行" page={1} totalPages={3} onPageChange={onPageChange} />
    )

    const { prev, next } = parts()
    fireEvent.click(prev)
    fireEvent.click(next)

    expect(onPageChange).toHaveBeenNthCalledWith(1, 0)
    expect(onPageChange).toHaveBeenNthCalledWith(2, 2)
  })

  it('stops at either end of the pages', () => {
    const { rerender } = render(
      <PreviewFooter summary="x" page={0} totalPages={3} onPageChange={vi.fn()} />
    )
    expect(parts().prev).toBeDisabled()
    expect(parts().next).toBeEnabled()

    rerender(<PreviewFooter summary="x" page={2} totalPages={3} onPageChange={vi.fn()} />)
    expect(parts().next).toBeDisabled()
  })

  it('stops both ways while a page is loading', () => {
    render(<PreviewFooter summary="x" page={1} totalPages={3} busy onPageChange={vi.fn()} />)

    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
  })
})
