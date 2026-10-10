/**
 * Runs EZPZ File JTD off the main thread. A document it cannot finish laying
 * out then stalls only this worker, which the page ends after a while and
 * falls back from (ichitaro-viewer.ts); laying out a long sheet does not hold
 * up the page either.
 */
import type { JtdPage } from './ichitaro-paint'
import type { ViewerReply, ViewerRequest } from './ichitaro-viewer'

/** The viewer built from EZPZ File JTD (apps/web/wasm/ezpzjtd-viewer), vendored under public/. */
const VIEWER_MODULE_URL = '/vendor/ezpzjtd/ezpzjtd_viewer.js'

interface JtdViewer {
  sheetCount(): number
  sheetName(index: number): string
  sheetPages(index: number): string
}

interface ViewerModule {
  default: () => Promise<unknown>
  JtdViewer: new (bytes: Uint8Array) => JtdViewer
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ViewerRequest>) => void) | null
  postMessage(reply: ViewerReply): void
}

let viewer: JtdViewer | undefined

scope.onmessage = async ({ data: request }) => {
  try {
    if (request.type === 'open') {
      const ezpz = (await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ VIEWER_MODULE_URL
      )) as ViewerModule
      await ezpz.default()
      const opened = new ezpz.JtdViewer(new Uint8Array(request.bytes))
      viewer = opened
      const names = Array.from({ length: opened.sheetCount() }, (_, i) => opened.sheetName(i))
      scope.postMessage({ id: request.id, names })
    } else {
      if (!viewer) throw new Error('No document is open')
      const pages = JSON.parse(viewer.sheetPages(request.sheet)) as JtdPage[]
      scope.postMessage({ id: request.id, pages })
    }
  } catch (err) {
    scope.postMessage({ id: request.id, error: err instanceof Error ? err.message : String(err) })
  }
}
