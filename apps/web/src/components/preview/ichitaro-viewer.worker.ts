/**
 * Runs EZPZ File JTD off the main thread. A document it cannot finish laying
 * out then stalls only this worker, which the page ends after a while and
 * falls back from (ichitaro-viewer.ts); laying out a long sheet does not hold
 * up the page either.
 */
import { capMemory } from '../../../vendor/ibis-office/boot/cap-memory.js'
import { compoundWithinBudget } from './compound-budget'
import type { JtdPage } from './ichitaro-paint'
import type { ViewerReply, ViewerRequest } from './ichitaro-viewer'

/** The viewer built from EZPZ File JTD (apps/web/wasm/ezpzjtd-viewer), vendored under public/. */
const VIEWER_MODULE_URL = '/vendor/ezpzjtd/ezpzjtd_viewer.js'
const VIEWER_WASM_URL = '/vendor/ezpzjtd/ezpzjtd_viewer_bg.wasm'
/** A ceiling on its memory, in 64 KiB pages: 256 MiB. Public documents take under 10 MB. */
const MEMORY_MAX_PAGES = 4096

interface JtdViewer {
  sheetCount(): number
  sheetName(index: number): string
  sheetPages(index: number): string
}

interface ViewerModule {
  default: (init: { module_or_path: WebAssembly.Module }) => Promise<unknown>
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
      if (!compoundWithinBudget(new Uint8Array(request.bytes))) {
        throw new Error('The file claims more than it holds')
      }
      const ezpz = (await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ VIEWER_MODULE_URL
      )) as ViewerModule
      // wasm32 declares no maximum: past this, an allocation fails inside it, and
      // the page falls back, where the tab would otherwise go down
      const wasm = await fetch(VIEWER_WASM_URL)
      if (!wasm.ok) throw new Error(`viewer ${wasm.status}`)
      const capped = capMemory(new Uint8Array(await wasm.arrayBuffer()), MEMORY_MAX_PAGES)
      await ezpz.default({ module_or_path: await WebAssembly.compile(capped as BufferSource) })
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
