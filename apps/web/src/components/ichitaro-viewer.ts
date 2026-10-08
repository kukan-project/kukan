import type { JtdPage } from './ichitaro-paint'

type RequestBody = { type: 'open'; bytes: ArrayBuffer } | { type: 'pages'; sheet: number }

export type ViewerRequest = RequestBody & { id: number }

export type ViewerReply =
  { id: number; names: string[] } | { id: number; pages: JtdPage[] } | { id: number; error: string }

/**
 * How long the viewer may take over a request before its worker is ended.
 * Opening loads the WASM; laying out a sheet of tens of pages takes well
 * under a second, so only a layout that will not end runs this long.
 */
const REPLY_TIMEOUT_MS = 15_000

interface Waiting {
  resolve: (reply: ViewerReply) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** An Ichitaro document open in EZPZ File JTD, in a worker of its own (ichitaro-viewer.worker.ts). */
export class IchitaroViewer {
  private readonly worker: Worker
  private readonly waiting = new Map<number, Waiting>()
  private readonly laid = new Map<number, Promise<JtdPage[]>>()
  private nextId = 0
  private closed = false

  private constructor() {
    this.worker = new Worker(new URL('./ichitaro-viewer.worker.ts', import.meta.url), {
      type: 'module',
    })
    this.worker.onmessage = ({ data }: MessageEvent<ViewerReply>) => {
      const waiting = this.waiting.get(data.id)
      if (!waiting) return
      this.waiting.delete(data.id)
      clearTimeout(waiting.timer)
      if ('error' in data) waiting.reject(new Error(data.error))
      else waiting.resolve(data)
    }
    this.worker.onerror = () => this.close()
  }

  /** Open `bytes`, which go to the worker; with each sheet's name, empty where the file names it not. */
  static async open(bytes: ArrayBuffer): Promise<{ viewer: IchitaroViewer; names: string[] }> {
    const viewer = new IchitaroViewer()
    try {
      const reply = await viewer.request({ type: 'open', bytes }, [bytes])
      if (!('names' in reply)) throw new Error('The viewer gave no sheets')
      return { viewer, names: reply.names }
    } catch (err) {
      viewer.close()
      throw err
    }
  }

  /** A sheet laid out into pages, once: asked for again, the same pages. */
  pages(sheet: number): Promise<JtdPage[]> {
    let laid = this.laid.get(sheet)
    if (!laid) {
      laid = this.request({ type: 'pages', sheet }).then((reply) => {
        if (!('pages' in reply)) throw new Error('The viewer gave no pages')
        return reply.pages
      })
      this.laid.set(sheet, laid)
    }
    return laid
  }

  /** End the worker; what is still waiting on it fails. */
  close(): void {
    this.closed = true
    this.worker.terminate()
    for (const waiting of this.waiting.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error('The viewer was closed'))
    }
    this.waiting.clear()
  }

  private request(body: RequestBody, transfer: Transferable[] = []): Promise<ViewerReply> {
    if (this.closed) return Promise.reject(new Error('The viewer was closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), REPLY_TIMEOUT_MS)
      this.waiting.set(id, { resolve, reject, timer })
      this.worker.postMessage({ ...body, id } satisfies ViewerRequest, transfer)
    })
  }
}
