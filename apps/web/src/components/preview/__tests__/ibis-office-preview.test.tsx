import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { IbisOfficePreview } from '../ibis-office-preview'
import { IBIS_OFFICE_BOOT, IBIS_OFFICE_HOME } from '@/lib/ibis-office'

vi.mock('@/lib/client-api', () => ({ clientFetch: vi.fn() }))
import { clientFetch } from '@/lib/client-api'
const mockClientFetch = vi.mocked(clientFetch)

// What a worker would answer: happy-dom runs none, and office-package-check's own tests cover it
let verdict = 'ok'
let checkedUpTo = 0
class WorkerStub {
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  postMessage(request: { limit: number }) {
    checkedUpTo = request.limit
    if (verdict !== 'silent') queueMicrotask(() => this.onmessage?.({ data: verdict }))
  }
  terminate() {}
}

const XLSX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])
const XLS = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1])
const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d])

/** What the observers report: scrolled to or not, and laid out or `hidden`. */
function view({ scrolledTo = true, width = 800 }: { scrolledTo?: boolean; width?: number } = {}) {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() {
        this.callback([{ isIntersecting: scrolledTo }])
      }
      disconnect() {}
    }
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: (entries: { contentRect: { width: number } }[]) => void) {}
      observe() {
        this.callback([{ contentRect: { width } }])
      }
      disconnect() {}
    }
  )
}

/**
 * Stands in for the frame's window: happy-dom loads no frame's page, so the
 * frame has none of its own.
 */
function frameWindow() {
  const target = { postMessage: vi.fn() }
  Object.defineProperty(document.querySelector('iframe')!, 'contentWindow', { value: target })
  return target
}

/** Posts a message to the page as the frame would. */
function fromFrame(type: string) {
  const source = document.querySelector('iframe')!.contentWindow as unknown as Window
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type }, source }))
  })
}

/** The preview on a resource whose file is this, with a frame to talk to. */
function renderWith(file: Response) {
  view()
  mockClientFetch.mockResolvedValue(file)
  render(<IbisOfficePreview resourceId="r1" doc="r1:1" format="XLSX" />)
  return frameWindow()
}

beforeEach(() => {
  mockClientFetch.mockReset()
  localStorage.clear()
  verdict = 'ok'
  vi.stubGlobal('Worker', WorkerStub)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(WASM))
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('IbisOfficePreview (ADR-065)', () => {
  it('runs the boot page in a frame sandboxed to scripts alone, and credits ibisOffice', () => {
    renderWith(new Response(XLSX))

    const frame = document.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe(IBIS_OFFICE_BOOT)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(screen.getByRole('link', { name: 'ibisOffice' })).toHaveAttribute(
      'href',
      IBIS_OFFICE_HOME
    )
  })

  it.each([
    ['hidden', { width: 0 }],
    ['not yet scrolled to', { scrolledTo: false }],
  ])('runs nothing while %s', (_, state) => {
    view(state)
    render(<IbisOfficePreview resourceId="r1" doc="r1:1" format="XLSX" />)
    expect(document.querySelector('iframe')).toBeNull()
    expect(mockClientFetch).not.toHaveBeenCalled()
  })

  it('fetches nothing until the frame has booted', () => {
    renderWith(new Response(XLSX))
    expect(mockClientFetch).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('hands the frame the document and the app once, named by what the bytes are', async () => {
    // An XLS's signature under an .xlsx resource: ibisOffice is told it is an XLS
    const { postMessage } = renderWith(new Response(XLS))

    fromFrame('boot')
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1))
    expect(postMessage.mock.calls[0]![0]).toMatchObject({ type: 'open', name: 'document.xls' })

    // A frame navigated by code inside it boots again, and is given nothing
    fromFrame('boot')
    await new Promise((r) => setTimeout(r, 50))
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('does not hand over a package that is not plainly built', async () => {
    verdict = 'refused'
    const { postMessage } = renderWith(new Response(XLSX))
    fromFrame('boot')
    expect(await screen.findByText(/could not be shown in the browser/)).toBeInTheDocument()
    expect(postMessage).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('says so of a package that unpacks past the limit', async () => {
    verdict = 'too-large'
    renderWith(new Response(XLSX))
    fromFrame('boot')
    expect(await screen.findByText(/too large to show its original/)).toBeInTheDocument()
    expect(checkedUpTo).toBe(128 * 1024 * 1024)
  })

  it('gives up on a package that takes too long to unpack', async () => {
    verdict = 'silent'
    const { postMessage } = renderWith(new Response(XLSX))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fromFrame('boot')
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    vi.useRealTimers()
    expect(await screen.findByText(/could not be shown in the browser/)).toBeInTheDocument()
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('does not look into a compound document', async () => {
    verdict = 'refused'
    const { postMessage } = renderWith(new Response(XLS))
    fromFrame('boot')
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1))
  })

  it('marks the document from handing it over until the frame goes, drawn or not', async () => {
    const { postMessage } = renderWith(new Response(XLSX))
    fromFrame('boot')
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1))
    expect(localStorage.length).toBe(1)
    expect(localStorage.key(0)).toContain('r1:1')

    // ibisOffice opens its window and draws after saying so: what takes a tab down comes then
    fromFrame('ready')
    expect(localStorage.length).toBe(1)

    cleanup()
    expect(localStorage.length).toBe(0)
  })

  it('removes the mark on giving up, which a crash does not do', async () => {
    const { postMessage } = renderWith(new Response(XLSX))
    fromFrame('boot')
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1))

    fromFrame('error')
    await screen.findByText(/could not be shown in the browser/)
    expect(localStorage.length).toBe(0)
  })

  it('heeds only its own frame', async () => {
    renderWith(new Response(XLSX))
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'error' }, source: window }))
    })
    expect(document.querySelector('iframe')).not.toBeNull()

    fromFrame('error')
    expect(await screen.findByText(/could not be shown in the browser/)).toBeInTheDocument()
  })

  it('does not fetch a file over the limit, and says so', () => {
    view()
    render(<IbisOfficePreview resourceId="r1" doc="r1:1" format="XLSX" size={65 * 1024 * 1024} />)
    expect(screen.getByText(/too large to show its original/)).toBeInTheDocument()
    expect(document.querySelector('iframe')).toBeNull()
    expect(mockClientFetch).not.toHaveBeenCalled()
  })

  it('stops reading a file that turns out larger than the limit', async () => {
    renderWith(new Response(XLSX, { headers: { 'content-length': String(65 * 1024 * 1024) } }))
    fromFrame('boot')
    expect(await screen.findByText(/too large to show its original/)).toBeInTheDocument()
  })

  it('passes on neither a ZIP nor a compound document', async () => {
    const { postMessage } = renderWith(new Response('<html>'))
    fromFrame('boot')
    expect(await screen.findByText(/could not be shown in the browser/)).toBeInTheDocument()
    expect(postMessage).not.toHaveBeenCalled()
  })

  describe('a frame that stays silent', () => {
    const THIRTY_SECONDS = 30_000
    const place = (top: number) =>
      vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue({ top, bottom: top + 700 } as DOMRect)

    it('is given up on, as one the CSP blocks never boots', () => {
      vi.useFakeTimers()
      place(0)
      renderWith(new Response(XLSX))
      act(() => vi.advanceTimersByTime(THIRTY_SECONDS))
      expect(screen.getByText(/could not be shown in the browser/)).toBeInTheDocument()
    })

    it('is not given up on while out of sight, where it draws nothing', () => {
      vi.useFakeTimers()
      const rect = place(5_000)
      renderWith(new Response(XLSX))
      act(() => vi.advanceTimersByTime(THIRTY_SECONDS * 3))
      expect(document.querySelector('iframe')).not.toBeNull()

      rect.mockReturnValue({ top: 0, bottom: 700 } as DOMRect)
      act(() => vi.advanceTimersByTime(THIRTY_SECONDS))
      expect(screen.getByText(/could not be shown in the browser/)).toBeInTheDocument()
    })

    it('counts only the time in sight, whenever it left and came back', () => {
      vi.useFakeTimers()
      const rect = place(0)
      renderWith(new Response(XLSX))
      act(() => vi.advanceTimersByTime(1_000))

      rect.mockReturnValue({ top: 5_000, bottom: 5_700 } as DOMRect)
      act(() => vi.advanceTimersByTime(THIRTY_SECONDS - 1_100))

      // Back just before the moment a timer started on arrival would have fired
      rect.mockReturnValue({ top: 0, bottom: 700 } as DOMRect)
      act(() => vi.advanceTimersByTime(THIRTY_SECONDS - 2_000))
      expect(document.querySelector('iframe')).not.toBeNull()

      act(() => vi.advanceTimersByTime(2_000))
      expect(screen.getByText(/could not be shown in the browser/)).toBeInTheDocument()
    })
  })
})
