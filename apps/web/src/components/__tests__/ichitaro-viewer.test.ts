import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IchitaroViewer } from '../ichitaro-viewer'

/** A worker that takes requests and answers none, as one stuck laying out a page would. */
class StuckWorker {
  static last: StuckWorker | undefined
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  posted: unknown[] = []
  terminated = false
  constructor() {
    StuckWorker.last = this
  }
  postMessage(message: unknown) {
    this.posted.push(message)
  }
  terminate() {
    this.terminated = true
  }
}

describe('IchitaroViewer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('Worker', StuckWorker)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('ends a worker that does not answer, and fails what waited on it', async () => {
    const opening = IchitaroViewer.open(new ArrayBuffer(8))
    const failed = expect(opening).rejects.toThrow('closed')
    await vi.advanceTimersByTimeAsync(15_000)
    await failed
    expect(StuckWorker.last!.terminated).toBe(true)
  })

  it('lays a sheet out once, however often it is asked for', async () => {
    const opening = IchitaroViewer.open(new ArrayBuffer(8))
    const worker = StuckWorker.last!
    worker.onmessage!({ data: { id: 0, names: ['', ''] } } as MessageEvent)
    const { viewer, names } = await opening
    expect(names).toEqual(['', ''])

    const first = viewer.pages(1)
    const again = viewer.pages(1)
    expect(again).toBe(first)
    expect(worker.posted).toHaveLength(2)
    worker.onmessage!({ data: { id: 1, pages: [{ w: 1, h: 1, items: [] }] } } as MessageEvent)
    await expect(first).resolves.toEqual([{ w: 1, h: 1, items: [] }])
    viewer.close()
  })
})
