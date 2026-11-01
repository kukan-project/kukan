import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor, cleanup } from '@testing-library/react'
import { stubObservers as view } from '@/__tests__/stub-observers'
import { IchitaroPreview } from '../ichitaro-preview'

vi.mock('@/lib/client-api', () => ({ clientFetch: vi.fn() }))
vi.mock('../ichitaro-viewer', () => ({
  IchitaroViewer: { open: vi.fn() },
}))
import { clientFetch } from '@/lib/client-api'
import { IchitaroViewer } from '../ichitaro-viewer'
const mockClientFetch = vi.mocked(clientFetch)
const mockOpen = vi.mocked(IchitaroViewer.open)

const COMPOUND = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1])
const viewer = { close: vi.fn(), pages: vi.fn(async () => []) }

const preview = (size?: number) => (
  <IchitaroPreview resourceId="r1" doc="r1:1" size={size} fallback={<p>not shown</p>} />
)

beforeEach(() => {
  localStorage.clear()
  mockClientFetch.mockReset()
  mockOpen.mockReset()
  viewer.close.mockClear()
  viewer.pages.mockReset()
  viewer.pages.mockResolvedValue([])
  mockOpen.mockResolvedValue({ viewer: viewer as never, names: ['one'] })
})
afterEach(() => vi.unstubAllGlobals())

describe('IchitaroPreview', () => {
  it.each([
    ['hidden', { width: 0 }],
    ['not yet scrolled to', { scrolledTo: false }],
  ])('fetches nothing while %s', (_, state) => {
    view(state)
    render(preview())
    expect(mockClientFetch).not.toHaveBeenCalled()
  })

  it('does not fetch a file over the limit', () => {
    view()
    render(preview(65 * 1024 * 1024))
    expect(screen.getByText('not shown')).toBeInTheDocument()
    expect(mockClientFetch).not.toHaveBeenCalled()
  })

  it('stops reading a file that turns out larger than the limit', async () => {
    view()
    mockClientFetch.mockResolvedValue(
      new Response(COMPOUND, { headers: { 'content-length': String(65 * 1024 * 1024) } })
    )
    render(preview())
    expect(await screen.findByText('not shown')).toBeInTheDocument()
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('does not hand over what is not a compound file', async () => {
    view()
    mockClientFetch.mockResolvedValue(new Response('<html>'))
    render(preview())
    expect(await screen.findByText('not shown')).toBeInTheDocument()
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('marks the document while open, and closes the viewer with it', async () => {
    view()
    mockClientFetch.mockResolvedValue(new Response(COMPOUND))
    render(preview())
    await waitFor(() => expect(mockOpen).toHaveBeenCalled())
    expect(localStorage.key(0)).toContain('r1:1')

    await waitFor(() => expect(viewer.pages).toHaveBeenCalled())
    cleanup()
    expect(viewer.close).toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
  })

  it('closes the viewer and removes the mark when a sheet cannot be laid out', async () => {
    view()
    mockClientFetch.mockResolvedValue(new Response(COMPOUND))
    viewer.pages.mockRejectedValue(new Error('out of memory'))
    render(preview())
    expect(await screen.findByText('not shown')).toBeInTheDocument()
    expect(viewer.close).toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
  })

  it('closes while hidden, without calling that a failure, and opens anew when shown', async () => {
    const { hide, show } = view()
    mockClientFetch.mockImplementation(async () => new Response(COMPOUND))
    render(preview())
    await waitFor(() => expect(viewer.pages).toHaveBeenCalled())

    act(() => hide())
    expect(viewer.close).toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText('not shown')).not.toBeInTheDocument()

    act(() => show())
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(localStorage.length).toBe(1))
  })

  it('does not try a failed document again on being shown again', async () => {
    const { hide, show } = view()
    mockClientFetch.mockImplementation(async () => new Response('<html>'))
    render(preview())
    await screen.findByText('not shown')

    act(() => hide())
    act(() => show())
    await new Promise((r) => setTimeout(r, 20))
    expect(mockClientFetch).toHaveBeenCalledTimes(1)
    expect(screen.getByText('not shown')).toBeInTheDocument()
  })

  it('leaves no mark for a document hidden before it could be opened', async () => {
    view()
    mockClientFetch.mockResolvedValue(new Response(COMPOUND))
    render(preview())
    cleanup()
    await new Promise((r) => setTimeout(r, 20))
    expect(mockOpen).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
  })

  it('stops the worker of a document hidden while it opens, and takes no new mark away', async () => {
    const { hide, show } = view()
    mockClientFetch.mockImplementation(async () => new Response(COMPOUND))
    let rejectFirst = (_: Error) => {}
    mockOpen.mockImplementationOnce(() => new Promise((_, reject) => (rejectFirst = reject)))
    render(preview())
    await waitFor(() => expect(mockOpen).toHaveBeenCalled())
    const signal = mockOpen.mock.calls[0]![1]!

    act(() => hide())
    expect(signal.aborted).toBe(true)

    act(() => show())
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(localStorage.length).toBe(1))
    await act(async () => rejectFirst(new Error('closed')))
    expect(localStorage.length).toBe(1)
    expect(screen.queryByText('not shown')).not.toBeInTheDocument()
  })

  it('removes the mark on failing, which a crash does not do', async () => {
    view()
    mockClientFetch.mockResolvedValue(new Response(COMPOUND))
    mockOpen.mockRejectedValue(new Error('no'))
    render(preview())
    expect(await screen.findByText('not shown')).toBeInTheDocument()
    expect(localStorage.length).toBe(0)
  })
})
