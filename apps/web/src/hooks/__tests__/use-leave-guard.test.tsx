import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useLeaveGuard } from '../use-leave-guard'

function Page({
  active,
  onFollow,
  within,
}: {
  active: boolean
  onFollow: () => void
  within?: string
}) {
  useLeaveGuard(active, 'leave?', within)
  return (
    <>
      <a href="/elsewhere" onClick={(e) => (e.preventDefault(), onFollow())}>
        away
      </a>
      <a href="#part" onClick={(e) => (e.preventDefault(), onFollow())}>
        fragment
      </a>
    </>
  )
}

/** The test DOM has no dialog to answer; this one answers `answer` */
function answer(value: boolean) {
  const confirm = vi.fn(() => value)
  vi.stubGlobal('confirm', confirm)
  return confirm
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useLeaveGuard', () => {
  it('lets a link through without asking while nothing is unsaved', () => {
    const confirm = answer(true)
    const onFollow = vi.fn()
    const { getByText } = render(<Page active={false} onFollow={onFollow} />)
    fireEvent.click(getByText('away'))
    expect(confirm).not.toHaveBeenCalled()
    expect(onFollow).toHaveBeenCalled()
  })

  it('stops a link to another page when the answer is to stay', () => {
    answer(false)
    const onFollow = vi.fn()
    const { getByText } = render(<Page active onFollow={onFollow} />)
    fireEvent.click(getByText('away'))
    // The link's own handler — where Next's Link navigates — never runs
    expect(onFollow).not.toHaveBeenCalled()
  })

  it('follows the link when the answer is to leave, off its own history entry', () => {
    // Followed from on top of the entry, Back from the new page would land on
    // this page twice
    answer(true)
    const back = vi
      .spyOn(window.history, 'back')
      .mockImplementation(() =>
        window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
      )
    const onFollow = vi.fn()
    const { getByText } = render(<Page active onFollow={onFollow} />)
    fireEvent.click(getByText('away'))
    expect(back).toHaveBeenCalledTimes(1)
    expect(onFollow).toHaveBeenCalledTimes(1)
  })

  it('does not ask for a fragment on the same page, or a link opened in a new tab', () => {
    const confirm = answer(true)
    const onFollow = vi.fn()
    const { getByText } = render(<Page active onFollow={onFollow} />)
    fireEvent.click(getByText('fragment'))
    fireEvent.click(getByText('away'), { ctrlKey: true })
    expect(confirm).not.toHaveBeenCalled()
    expect(onFollow).toHaveBeenCalledTimes(2)
  })

  it('asks on Back, and puts its entry back when the answer is to stay', () => {
    answer(false)
    const push = vi.spyOn(window.history, 'pushState')
    render(<Page active onFollow={vi.fn()} />)
    expect(push).toHaveBeenCalledTimes(1)

    // Back has left the guard's entry for the page's own
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    expect(window.confirm).toHaveBeenCalledWith('leave?')
    expect(push).toHaveBeenCalledTimes(2)
  })

  it('takes the step further back when the answer is to leave', () => {
    answer(true)
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    render(<Page active onFollow={vi.fn()} />)
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('takes its entry away when the edits are saved on the page', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { rerender } = render(<Page active onFollow={vi.fn()} />)
    rerender(<Page active={false} onFollow={vi.fn()} />)
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('lets a link through that stays within what holds the edits', () => {
    // The editor's list keeps a staged order across its own pages
    const confirm = answer(false)
    const onFollow = vi.fn()
    const { getByText } = render(<Page active onFollow={onFollow} within="/elsewhere" />)
    fireEvent.click(getByText('away'))
    expect(confirm).not.toHaveBeenCalled()
    expect(onFollow).toHaveBeenCalled()
  })
})
