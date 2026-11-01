import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { crashedBefore, openDocument } from '../original-draw-marks'

const SECOND = 1000
const leftBy = (tab: string, age: number) =>
  localStorage.setItem(`kukan:original-draw:r1:1:${tab}`, String(Date.now() - age))

function hide(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.useFakeTimers()
})
afterEach(() => {
  hide(false)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('office draw marks (ADR-065 decision 3)', () => {
  it('finds nothing where nothing was left', () => {
    expect(crashedBefore('r1:1')).toBe(false)
  })

  it('takes a mark no one is renewing for a crash', () => {
    leftBy('gone', 60 * SECOND)
    expect(crashedBefore('r1:1')).toBe(true)
  })

  it('takes a fresh mark for another tab still drawing it', () => {
    leftBy('other', 2 * SECOND)
    expect(crashedBefore('r1:1')).toBe(false)
  })

  it('keeps one document’s mark from another’s', () => {
    leftBy('gone', 60 * SECOND)
    expect(crashedBefore('r1:2')).toBe(false)
    expect(crashedBefore('r1:')).toBe(false)
  })

  it('tries the document again after a day, and forgets the mark', () => {
    leftBy('gone', 25 * 60 * 60 * SECOND)
    expect(crashedBefore('r1:1')).toBe(false)
    expect(localStorage.length).toBe(0)
  })

  it('renews its mark while drawing, so no other tab takes it for a crash', () => {
    const stop = openDocument('r1:1')
    expect(localStorage.length).toBe(1)

    vi.advanceTimersByTime(60 * SECOND)
    expect(crashedBefore('r1:1')).toBe(false)
    stop()
    expect(localStorage.length).toBe(0)
  })

  it('takes its own mark for a crash, however fresh, once the page that left it is gone', () => {
    // A reload of the crashed tab: the mark is under this tab's name, with no page holding it
    const stop = openDocument('r1:1')
    const mark = localStorage.key(0)!
    stop()
    localStorage.setItem(mark, String(Date.now()))
    expect(crashedBefore('r1:1')).toBe(true)
  })

  it('takes no mark for a crash while this page has the document open', () => {
    const stop = openDocument('r1:1')
    expect(crashedBefore('r1:1')).toBe(false)
    stop()
  })

  it('forgets an expired mark of any document, as of a version no one opens again', () => {
    localStorage.setItem('kukan:original-draw:r9:1:gone', String(Date.now() - 25 * 3600 * SECOND))
    crashedBefore('r1:1')
    expect(localStorage.length).toBe(0)
  })

  it('replaces what an earlier crash left, leaving another tab’s mark alone', () => {
    leftBy('gone', 60 * SECOND)
    leftBy('other', 2 * SECOND)
    const stop = openDocument('r1:1')
    stop()
    expect(crashedBefore('r1:1')).toBe(false)
    expect(localStorage.getItem('kukan:original-draw:r1:1:other')).not.toBeNull()
    expect(localStorage.length).toBe(1)
  })

  it('holds no mark while the tab is hidden, and takes it up again when seen', () => {
    const stop = openDocument('r1:1')
    hide(true)
    expect(localStorage.length).toBe(0)
    vi.advanceTimersByTime(60 * SECOND)
    expect(localStorage.length).toBe(0)

    hide(false)
    expect(localStorage.length).toBe(1)
    stop()
  })

  it('removes the mark when the page goes away, which a crash does not do', () => {
    const close = openDocument('r1:1')
    window.dispatchEvent(new Event('pagehide'))
    expect(localStorage.length).toBe(0)
    close()
    expect(crashedBefore('r1:1')).toBe(false)
  })

  it('takes the mark up again when the page comes back from the back/forward cache', () => {
    const close = openDocument('r1:1')
    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new Event('pageshow'))
    expect(localStorage.length).toBe(1)

    vi.advanceTimersByTime(60 * SECOND)
    expect(crashedBefore('r1:1')).toBe(false)
    close()
    expect(localStorage.length).toBe(0)

    window.dispatchEvent(new Event('pageshow'))
    expect(localStorage.length).toBe(0)
  })

  it('keeps working where storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(crashedBefore('r1:1')).toBe(false)
    expect(() => openDocument('r1:1')()).not.toThrow()
  })
})
